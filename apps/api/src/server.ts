import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgent, type Agent } from '@wecom/agent';
import { defaults, ROLES, sundayOf, weekBoundaryFrom, weekId, type Role } from '@wecom/domain';
import { inTransaction, openDb, type Db } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { DailyAssistantApp } from './app';
import { seedDemoData, SEED_WEEK } from './seed';
import { CrmError, CrmStore, seedCrmDemo } from '../../../packages/persistence/src/crm';
import { crmRequest } from './crm-api';
import { workspaceRequest } from './workspace-api';
import { reportingRequest } from './reporting-api';
import { buildStructuredArchive } from './archive';
import { getWeeklyDetail, saveWeeklyFeedback } from './weekly-workflow';
import { notificationOverview, updateNotificationSettings, retryNotification } from './notifications';
import { proposeAction, confirmAction, cancelAction, AssistantActionError, type AssistantActionInput } from './assistant-actions';
import { createDirectoryReader, type DirectoryReader } from './directory-sheet';
import { NewCompanySheets, publicCompany } from './new-companies';
import { DirectoryService, DirectoryBusyError } from './directory-service';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const dateAt = (ymd: string) => new Date(`${ymd}T04:00:00Z`);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

interface Session {
  userId: string;
  role: Role;
  expiresAt: number;
  resourceId?: string;
  publicWeekly?: boolean;
  publicWeeklyEmployee?: boolean;
}

const PUBLIC_WEEKLY_SCOPE = 'public-weekly-poc';
const PUBLIC_WEEKLY_EMPLOYEE_SCOPE = 'public-weekly-employee-poc';
const MANAGEMENT_ROLES: readonly Role[] = ['team_lead', 'dept_head', 'admin'];

const ROLE_OPTIONS: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'employee', label: '员工' },
  { value: 'team_lead', label: '小组长' },
  { value: 'dept_head', label: '部门领导' },
  { value: 'admin', label: '管理员' },
];

function roleFrom(value: unknown): Role | undefined {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value) ? value as Role : undefined;
}

function directoryUserView(db: Db, user: repo.UserRow, usersById: Map<string, repo.UserRow>) {
  const manager = user.manager_user_id ? usersById.get(user.manager_user_id) : undefined;
  const activation = repo.getLatestActivationCode(db, user.id);
  const now = new Date().toISOString();
  const activationStatus = !activation ? 'none'
    : activation.used_at ? 'used'
      : activation.revoked_at ? 'revoked'
        : activation.expires_at <= now ? 'expired'
          : 'available';
  return {
    id: user.id,
    name: user.name,
    displayName: user.name,
    department: user.department,
    role: user.role,
    managerUserId: user.manager_user_id,
    managerName: manager?.name ?? null,
    directReportCount: repo.countDirectReports(db, user.id),
    bindingStatus: repo.isUserBound(user) ? 'bound' : 'unbound',
    activationStatus,
    activationExpiresAt: activationStatus === 'available' ? activation?.expires_at : null,
  };
}

function createsReportingCycle(usersById: Map<string, repo.UserRow>, userId: string, managerUserId: string): boolean {
  const visited = new Set<string>();
  let cursor: string | null = managerUserId;
  while (cursor && !visited.has(cursor)) {
    if (cursor === userId) return true;
    visited.add(cursor);
    cursor = usersById.get(cursor)?.manager_user_id ?? null;
  }
  return false;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ACTIVATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newActivationCode(): string {
  const bytes = randomBytes(8);
  let value = '';
  for (const byte of bytes) value += ACTIVATION_ALPHABET[byte % ACTIVATION_ALPHABET.length];
  return `SN-${value.slice(0, 4)}-${value.slice(4)}`;
}

function issueActivationCode(db: Db, userId: string): { code: string; expiresAt: string } {
  const code = newActivationCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  repo.createActivationCode(db, {
    id: randomUUID(), user_id: userId, code_hash: hashToken(code), expires_at: expiresAt, created_at: now.toISOString(),
  });
  return { code, expiresAt };
}

function knowledgeKind(value: unknown): repo.KnowledgeKind | undefined {
  return value === 'service_company' || value === 'park_material' || value === 'policy' || value === 'guide' ? value : undefined;
}

export interface ServerOptions {
  /** Only the isolated synthetic localhost weekly demo may request a code-free session. */
  localWeeklyDemo?: boolean;
  /** Explicit, temporary POC-only manager identity for the public mobile weekly report. */
  publicWeeklyUserName?: string;
  /** Explicit, temporary POC-only employee identity for their own public mobile weekly report. */
  publicWeeklyEmployeeName?: string;
  demoLabel?: string;
  directoryEnv?: NodeJS.ProcessEnv;
  directoryReader?: DirectoryReader;
  agent?: Agent;
  port?: number;
  host?: string;
  dbPath?: string;
  accessCode: string;
  allowedOrigins?: string[];
  demoMode?: boolean;
  sessionTtlMs?: number;
  weekBoundary?: string;
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function commonHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

function corsHeaders(origin: string | undefined, allowedOrigins: Set<string>): Record<string, string> {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: Set<string>,
): void {
  res.writeHead(status, {
    ...commonHeaders(),
    ...corsHeaders(origin, allowedOrigins),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是JSON对象');
  return parsed as Record<string, unknown>;
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(WEB_DIR, `.${rel}`);
  if (filePath !== WEB_DIR && !filePath.startsWith(`${WEB_DIR}${path.sep}`)) {
    res.writeHead(403, commonHeaders());
    res.end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, commonHeaders());
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    ...commonHeaders(),
    'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' https:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(readFileSync(filePath));
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function decodePathSegment(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function userCanRead(session: Session, targetUserId: string, db: Db): boolean {
  // A weekly-report scoped session is still checked against current management scope;
  // its exact report binding is enforced separately by the report endpoint.
  return repo.canReadUser(db, { userId: session.userId, role: session.role }, targetUserId);
}

interface ItemProgressView {
  workItemId: string;
  name: string;
  planBackground: string;
  progressValue: number;
  progressText: string;
  progressType: string;
  issues: string[];
  nextActions: string[];
  lastDate: string | null;
}

function itemProgressView(
  items: Array<{ id: string; name: string; plan_background: string }>,
  reports: repo.DailyReportRow[],
  requireConfirmed = true,
): ItemProgressView[] {
  const view = new Map(items.map((item) => [item.id, {
    workItemId: item.id,
    name: item.name,
    planBackground: item.plan_background,
    progressValue: 0,
    progressText: '',
    progressType: '其他',
    issues: [] as string[],
    nextActions: [] as string[],
    lastDate: null as string | null,
  }]));
  for (const report of reports.filter((entry) => !requireConfirmed || entry.status === 'confirmed')) {
    let parsed: unknown = [];
    try { parsed = JSON.parse(report.progress_json ?? '[]'); } catch { parsed = []; }
    if (!Array.isArray(parsed)) continue;
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const progress = raw as Record<string, unknown>;
      const item = typeof progress.workItemRef === 'string' ? view.get(progress.workItemRef) : undefined;
      if (!item) continue;
      item.progressValue = typeof progress.progressValue === 'number'
        ? Math.max(0, Math.min(100, Math.round(progress.progressValue)))
        : item.progressValue;
      item.progressText = typeof progress.progressText === 'string' ? progress.progressText : item.progressText;
      item.progressType = typeof progress.progressType === 'string' ? progress.progressType : item.progressType;
      item.issues = Array.isArray(progress.issues) ? progress.issues.filter((value): value is string => typeof value === 'string') : item.issues;
      item.nextActions = Array.isArray(progress.nextActions) ? progress.nextActions.filter((value): value is string => typeof value === 'string') : item.nextActions;
      item.lastDate = report.report_date;
    }
  }
  return [...view.values()];
}

export async function startServer(options: ServerOptions): Promise<ReturnType<typeof createServer>> {
  if (!options.accessCode.trim()) throw new Error('必须配置 POC_ACCESS_CODE');
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const allowedOrigins = new Set(options.allowedOrigins ?? [`http://${host}:${port}`, `http://localhost:${port}`]);
  const loginFailures = new Map<string, { count: number; blockedUntil: number }>();
  const db = openDb(options.dbPath ?? '.runtime/data/poc.sqlite');
  if (options.localWeeklyDemo && (!['127.0.0.1','::1'].includes(host) || !repo.getConfig(db,'weekly-ui-demo',false))) {
    db.close(); throw new Error('免码入口仅允许独立模拟数据库和本机监听');
  }
  if (options.demoMode && repo.listUsers(db).length === 0) await seedDemoData(db);
  if (options.demoMode) seedCrmDemo(new CrmStore(db));
  const publicWeeklyUserName = options.publicWeeklyUserName?.trim();
  const configuredPublicWeeklyUsers = publicWeeklyUserName
    ? repo.listUsers(db).filter((user) => user.active && user.name === publicWeeklyUserName)
    : [];
  if (publicWeeklyUserName && configuredPublicWeeklyUsers.length !== 1) {
    db.close(); throw new Error('公开周报入口必须唯一匹配一个在职人员');
  }
  const configuredPublicWeeklyUser = configuredPublicWeeklyUsers[0];
  if (configuredPublicWeeklyUser && !MANAGEMENT_ROLES.includes(configuredPublicWeeklyUser.role)) {
    db.close(); throw new Error('公开周报入口仅允许管理角色');
  }
  const publicWeeklyEmployeeName = options.publicWeeklyEmployeeName?.trim();
  const configuredPublicWeeklyEmployees = publicWeeklyEmployeeName
    ? repo.listUsers(db).filter((user) => user.active && user.name === publicWeeklyEmployeeName)
    : [];
  if (publicWeeklyEmployeeName && configuredPublicWeeklyEmployees.length !== 1) {
    db.close(); throw new Error('公开员工周报入口必须唯一匹配一个在职人员');
  }
  const configuredPublicWeeklyEmployee = configuredPublicWeeklyEmployees[0];
  if (configuredPublicWeeklyEmployee && configuredPublicWeeklyEmployee.role !== 'employee') {
    db.close(); throw new Error('公开员工周报入口仅允许员工角色');
  }
  const app = new DailyAssistantApp(db, options.agent ?? new MockAgent(), { weekBoundary: weekBoundaryFrom(options.weekBoundary) });
  const defaultWeek = options.demoMode ? SEED_WEEK : weekId(new Date());
  const directory = new DirectoryService(db, options.directoryReader ?? createDirectoryReader(options.directoryEnv ?? {}), options.directoryEnv?.DIRECTORY_SHEET_URL);

  const server = createServer(async (req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (origin && !allowedOrigins.has(origin)) {
      return sendJson(res, 403, { error: 'origin_not_allowed' }, undefined, allowedOrigins);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...commonHeaders(), ...corsHeaders(origin, allowedOrigins) });
      return res.end();
    }

    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;
    if (pathname === '/' && configuredPublicWeeklyUser) return serveStatic(res, '/weekly.html');
    if (pathname === '/employee-weekly.html' && !configuredPublicWeeklyEmployee) return sendJson(res,404,{error:'not_found'},origin,allowedOrigins);
    if (pathname === '/api/v1/health') {
      const dbOk = (db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
      return sendJson(res, dbOk ? 200 : 503, { ok: dbOk, database: dbOk, time: new Date().toISOString() }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/demo/weekly-session' && req.method === 'POST') {
      const localDemo = options.localWeeklyDemo && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
      const currentPublicUser = configuredPublicWeeklyUser ? repo.activeUser(db, configuredPublicWeeklyUser.id) : undefined;
      const publicPoc = Boolean(currentPublicUser && currentPublicUser.name === publicWeeklyUserName
        && MANAGEMENT_ROLES.includes(currentPublicUser.role));
      if (!localDemo && !publicPoc) return sendJson(res,404,{error:'not_found'},origin,allowedOrigins);
      const token = randomBytes(32).toString('base64url'), ttl = publicPoc ? 2 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
      const userId = publicPoc ? currentPublicUser!.id : 'poc-admin';
      const role: Role = publicPoc ? currentPublicUser!.role : 'admin';
      repo.insertAuthSession(db,{token_hash:hashToken(token),user_id:userId,role,resource_id:publicPoc?PUBLIC_WEEKLY_SCOPE:null,expires_at:new Date(Date.now()+ttl).toISOString(),created_at:new Date().toISOString()});
      if (publicPoc) repo.insertAudit(db,{id:randomUUID(),actor_user_id:userId,action:'public_weekly.session_issued',resource_type:'auth_session',resource_id:hashToken(token).slice(0,12),details_json:'{}',created_at:new Date().toISOString()});
      return sendJson(res,200,{token,expiresIn:ttl/1000},origin,allowedOrigins);
    }
    if (pathname === '/api/v1/demo/employee-weekly-session' && req.method === 'POST') {
      const currentEmployee = configuredPublicWeeklyEmployee ? repo.activeUser(db, configuredPublicWeeklyEmployee.id) : undefined;
      if (!currentEmployee || currentEmployee.name !== publicWeeklyEmployeeName || currentEmployee.role !== 'employee') {
        return sendJson(res,404,{error:'not_found'},origin,allowedOrigins);
      }
      const token = randomBytes(32).toString('base64url'), ttl = 2 * 60 * 60 * 1000;
      repo.insertAuthSession(db,{token_hash:hashToken(token),user_id:currentEmployee.id,role:'employee',resource_id:PUBLIC_WEEKLY_EMPLOYEE_SCOPE,expires_at:new Date(Date.now()+ttl).toISOString(),created_at:new Date().toISOString()});
      repo.insertAudit(db,{id:randomUUID(),actor_user_id:currentEmployee.id,action:'public_weekly_employee.session_issued',resource_type:'auth_session',resource_id:hashToken(token).slice(0,12),details_json:'{}',created_at:new Date().toISOString()});
      return sendJson(res,200,{token,expiresIn:ttl/1000},origin,allowedOrigins);
    }
    if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
      try {
        const remote = req.socket.remoteAddress ?? 'unknown';
        const attempt = loginFailures.get(remote);
        if (attempt && attempt.blockedUntil > Date.now()) {
          return sendJson(res, 429, { error: 'too_many_attempts' }, origin, allowedOrigins);
        }
        const body = await readJson(req);
        const accessCode = typeof body.accessCode === 'string' ? body.accessCode : '';
        if (!safeEqual(accessCode, options.accessCode)) {
          const count = (attempt?.count ?? 0) + 1;
          loginFailures.set(remote, { count, blockedUntil: count >= 5 ? Date.now() + 15 * 60_000 : 0 });
          return sendJson(res, 401, { error: 'invalid_access_code' }, origin, allowedOrigins);
        }
        loginFailures.delete(remote);
        const token = randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + (options.sessionTtlMs ?? 8 * 60 * 60 * 1000);
        repo.insertAuthSession(db, {
          token_hash: hashToken(token), user_id: 'poc-admin', role: 'admin', resource_id: null,
          expires_at: new Date(expiresAt).toISOString(), created_at: new Date().toISOString(),
        });
        return sendJson(res, 200, { token, expiresIn: Math.floor((options.sessionTtlMs ?? 8 * 60 * 60 * 1000) / 1000) }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/access-grants/exchange' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const grantToken = typeof body.token === 'string' ? body.token.trim() : '';
        if (!grantToken || grantToken.length > 256) throw new Error('访问授权无效');
        const now = new Date();
        const grant = repo.consumeAccessGrant(db, hashToken(grantToken), now.toISOString());
        if (!grant) return sendJson(res, 401, { error: 'grant_invalid_or_expired' }, origin, allowedOrigins);
        const user = repo.getUser(db, grant.user_id);
        const report = repo.getWeeklyReportById(db, grant.resource_id);
        if (!user?.active || !report || !userCanRead({ userId: user.id, role: user.role, expiresAt: 0 }, report.user_id, db)) return sendJson(res, 401, { error: 'grant_resource_unavailable' }, origin, allowedOrigins);
        const token = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(Date.parse(grant.expires_at), Date.now() + 2 * 60 * 60 * 1000);
        repo.insertAuthSession(db, {
          token_hash: hashToken(token), user_id: user.id, role: user.role, resource_id: report.id,
          expires_at: new Date(expiresAt).toISOString(), created_at: now.toISOString(),
        });
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: user.id, action: 'access_grant.exchanged',
          resource_type: 'weekly_report', resource_id: report.id,
          details_json: JSON.stringify({ grantId: grant.id }), created_at: now.toISOString(),
        });
        return sendJson(res, 200, {
          token,
          expiresIn: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
          route: `#/report/${report.user_id}/${report.week_id}`,
        }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/portal-grants/exchange' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const result = repo.exchangePortalAccessGrant(db, typeof body.token === 'string' ? body.token : '');
        return sendJson(res, 200, result, origin, allowedOrigins);
      } catch {
        return sendJson(res, 401, { error: '门户入口已过期、已使用或身份发生变化，请通过机器人重新获取' }, origin, allowedOrigins);
      }
    }

    const token = bearer(req);
    const persistedSession = token ? repo.getActiveAuthSession(db, hashToken(token), new Date().toISOString()) : undefined;
    const currentUser = persistedSession ? repo.activeUser(db, persistedSession.user_id) : undefined;
    const trustedPocAdmin = persistedSession?.user_id === 'poc-admin' && persistedSession.role === 'admin' && !persistedSession.resource_id;
    const publicWeeklySession = Boolean(persistedSession?.resource_id === PUBLIC_WEEKLY_SCOPE && configuredPublicWeeklyUser
      && currentUser?.id === configuredPublicWeeklyUser.id && currentUser.name === publicWeeklyUserName
      && MANAGEMENT_ROLES.includes(currentUser.role));
    const publicWeeklyEmployeeSession = Boolean(persistedSession?.resource_id === PUBLIC_WEEKLY_EMPLOYEE_SCOPE && configuredPublicWeeklyEmployee
      && currentUser?.id === configuredPublicWeeklyEmployee.id && currentUser.name === publicWeeklyEmployeeName
      && currentUser.role === 'employee');
    const regularUserSession = Boolean(currentUser && currentUser.role === persistedSession?.role
      && ![PUBLIC_WEEKLY_SCOPE,PUBLIC_WEEKLY_EMPLOYEE_SCOPE].includes(persistedSession?.resource_id ?? ''));
    const identityValid = Boolean(persistedSession && (trustedPocAdmin || publicWeeklySession || publicWeeklyEmployeeSession || regularUserSession)
      && repo.portalSessionIsValid(db, persistedSession));
    const session: Session | undefined = persistedSession && identityValid ? {
      userId: persistedSession.user_id,
      role: persistedSession.role,
      resourceId: publicWeeklySession || publicWeeklyEmployeeSession ? undefined : persistedSession.resource_id ?? undefined,
      publicWeekly: publicWeeklySession,
      publicWeeklyEmployee: publicWeeklyEmployeeSession,
      expiresAt: Date.parse(persistedSession.expires_at),
    } : undefined;
    if (!session) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'unauthorized' }, origin, allowedOrigins);
      return serveStatic(res, pathname);
    }

    if (session.publicWeekly) {
      const allowed = pathname === '/api/v1/new-companies' && req.method === 'GET'
        || pathname === '/api/v1/session' && req.method === 'GET'
        || pathname === '/api/v1/workspace' && req.method === 'GET'
        || /^\/api\/v1\/workspace\/weekly-reports\/[^/]+$/.test(pathname) && req.method === 'GET'
        || pathname === '/api/v1/reporting/weeks' && req.method === 'GET'
        || /^\/api\/v1\/reporting\/weeks\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(pathname) && req.method === 'GET'
        || /^\/api\/v1\/reporting\/feedback(?:\/[^/]+)?$/.test(pathname) && ['POST','PUT'].includes(req.method ?? '')
        || /^\/api\/v1\/reports\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(pathname) && req.method === 'GET'
        || /^\/api\/v1\/reports\/[^/]+\/\d{4}-\d{2}-\d{2}\/feedback$/.test(pathname) && ['POST','PUT'].includes(req.method ?? '');
      if (!allowed) return sendJson(res, 403, { error: 'public_weekly_scope_only' }, origin, allowedOrigins);
    }
    if (session.publicWeeklyEmployee) {
      const employeeReport = pathname.match(/^\/api\/v1\/reporting\/weeks\/([^/]+)\/\d{4}-\d{2}-\d{2}$/);
      const allowed = pathname === '/api/v1/session' && req.method === 'GET'
        || pathname === '/api/v1/workspace' && req.method === 'GET'
        || Boolean(employeeReport && decodePathSegment(employeeReport[1]) === session.userId && req.method === 'GET');
      if (!allowed) return sendJson(res, 403, { error: 'public_weekly_employee_scope_only' }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/new-companies' && req.method === 'GET') {
      if (session.resourceId || !['admin','team_lead','dept_head'].includes(session.role)) return sendJson(res, 403, {error:'forbidden'}, origin, allowedOrigins);
      try {
        const snapshot = await new NewCompanySheets(options.directoryEnv).snapshot();
        const allowedNames = new Set(repo.listUsers(db).filter(u => repo.canReadUser(db, {userId:session.userId,role:session.role,tenantId:'poc'},u.id)).map(u=>u.name));
        return sendJson(res,200,{rows:snapshot.fresh.filter(row=>session.role==='admin'||allowedNames.has(row['拜访员工'])).map(publicCompany)},origin,allowedOrigins);
      } catch { return sendJson(res,503,{error:'企业资料暂不可用'},origin,allowedOrigins); }
    }
    if (pathname === '/api/v1/auth/logout' && req.method === 'POST') {
      repo.revokeAuthSession(db, hashToken(token!), new Date().toISOString());
      return sendJson(res, 200, { ok: true }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/session') {
      return sendJson(res, 200, {
        userId: session.userId, role: session.role, expiresAt: session.expiresAt, resourceScoped: Boolean(session.resourceId),
        name: currentUser?.name ?? '管理员', demoMode: Boolean(options.demoMode), demoLabel: options.demoLabel,
        weeklyDemo: Boolean(options.localWeeklyDemo),
        publicWeekly: Boolean(session.publicWeekly),
        publicWeeklyEmployee: Boolean(session.publicWeeklyEmployee),
        canAdmin: session.role === 'admin' && !session.resourceId && !session.publicWeekly && !session.publicWeeklyEmployee,
        canManageTeam: ['admin','team_lead','dept_head'].includes(session.role) && !session.resourceId,
      }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/demo/portal' && req.method === 'POST') {
      if (!options.demoMode) return sendJson(res, 404, { error: 'not_found' }, origin, allowedOrigins);
      if (session.role !== 'admin' || session.resourceId) return sendJson(res, 403, { error: 'forbidden' }, origin, allowedOrigins);
      try {
        const body = await readJson(req);
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        const grant = repo.issueDemoPortalAccessGrant(db, typeof body.userId === 'string' ? body.userId : '', { baseUrl: `http://${host}:${actualPort}` });
        return sendJson(res, 200, { portalToken: grant.token, route: `#/portal/${grant.token}`, expiresAt: grant.expiresAt }, origin, allowedOrigins);
      } catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : '入口签发失败' }, origin, allowedOrigins); }
    }

    if (pathname.startsWith('/api/v1/reporting/')) {
      try {
        const body = ['POST','PUT'].includes(req.method ?? '') ? await readJson(req) : {};
        const result = await reportingRequest(db,app,{...session,tenantId:'poc'},url,req.method ?? 'GET',body,typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:'');
        return sendJson(res,result.status,result.body,origin,allowedOrigins);
      } catch(error) { return sendJson(res,error instanceof CrmError?error.status:(error&&typeof error==='object'&&'status' in error&&typeof error.status==='number'?error.status:400),{error:error instanceof Error?error.message:'请求失败'},origin,allowedOrigins); }
    }
    if (pathname.startsWith('/api/v1/assistant/')) {
      if (session.resourceId) return sendJson(res, 403, { error: '报告限定入口不能查询其他资料或执行后台操作' }, origin, allowedOrigins);
      const actor = { userId: session.userId, role: session.role, tenantId: 'poc' };
      try {
        const view = url.searchParams.get('view') ?? 'team';
        if (!['personal', 'team'].includes(view)) throw new Error('视图无效');
        const scope = { view: view as repo.WorkspaceView, companyId: url.searchParams.get('companyId') ?? undefined };
        if (pathname === '/api/v1/assistant/memory' && req.method === 'GET') {
          const result = repo.searchBusinessMemory(db, actor, { ...scope, query: url.searchParams.get('query') ?? '',
            fromDate: url.searchParams.get('fromDate') ?? undefined, toDate: url.searchParams.get('toDate') ?? undefined });
          return sendJson(res, 200, result, origin, allowedOrigins);
        }
        if (pathname === '/api/v1/assistant/knowledge' && req.method === 'GET') {
          const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase();
          if (!query || query.length > 160) throw new Error('请填写1—160字关键词');
          const entries = repo.filterReadableKnowledge(db, actor, undefined, scope)
            .filter(row => `${row.title}\n${row.content}`.toLocaleLowerCase().includes(query)).slice(0, 8)
            .map(row => ({ ...row, content: row.content.slice(0, 1500), truncated: row.content.length > 1500 }));
          return sendJson(res, 200, { entries }, origin, allowedOrigins);
        }
        if (pathname === '/api/v1/assistant/actions' && req.method === 'POST') {
          const body = await readJson(req);
          if (Object.keys(body).some(key => !['action', 'payload'].includes(key))) throw new Error('仅允许action和payload字段，身份由登录态决定');
          const requestId = req.headers['idempotency-key'];
          if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('请提供Idempotency-Key请求标识');
          const proposal = proposeAction(db, actor, { action: body.action as AssistantActionInput['action'], requestId, payload: body.payload as Record<string, unknown> });
          return sendJson(res, 200, { proposal }, origin, allowedOrigins);
        }
        const actionMatch = pathname.match(/^\/api\/v1\/assistant\/actions\/([^/]+)\/(confirm|cancel)$/);
        if (actionMatch && req.method === 'POST') {
          const body = await readJson(req);
          if (Object.keys(body).some(key => key !== 'confirmationToken')) throw new Error('不支持的确认参数');
          const id = decodeURIComponent(actionMatch[1]);
          const result = actionMatch[2] === 'confirm'
            ? confirmAction(db, actor, id, typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined)
            : cancelAction(db, actor, id);
          return sendJson(res, 200, { result }, origin, allowedOrigins);
        }
        return sendJson(res, 404, { error: 'not_found' }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, error instanceof AssistantActionError ? error.status : 400,
          { error: error instanceof Error ? error.message : '操作失败' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/workspace' || pathname.startsWith('/api/v1/workspace/')) {
      try {
        const body = ['POST','PUT','DELETE'].includes(req.method ?? '') ? await readJson(req) : {};
        const result = workspaceRequest(db, app, url, req.method ?? 'GET', body, session);
        return sendJson(res, result.status, result.body, origin, allowedOrigins);
      } catch (error) { return sendJson(res, error instanceof CrmError ? error.status : 400, { error: error instanceof Error ? error.message : '请求失败' }, origin, allowedOrigins); }
    }

    if (pathname.startsWith('/api/v1/admin/') && (session.role !== 'admin' || session.resourceId)) {
      return sendJson(res, 403, { error: 'forbidden' }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/notifications' && req.method === 'GET') {
      return sendJson(res, 200, notificationOverview(db), origin, allowedOrigins);
    }
    if (pathname === '/api/v1/admin/notifications/settings' && req.method === 'PUT') {
      try { return sendJson(res, 200, { settings: updateNotificationSettings(db, await readJson(req), session.userId) }, origin, allowedOrigins); }
      catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : '设置失败' }, origin, allowedOrigins); }
    }
    const notificationRetry = pathname.match(/^\/api\/v1\/admin\/notifications\/([^/]+)\/retry$/);
    if (notificationRetry && req.method === 'POST') {
      try { retryNotification(db, decodeURIComponent(notificationRetry[1]), session.userId); return sendJson(res, 200, { ok: true }, origin, allowedOrigins); }
      catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : '重试失败' }, origin, allowedOrigins); }
    }
    const portalRevoke = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)\/portal-access\/revoke$/);
    if (portalRevoke && req.method === 'POST') {
      try {
        const id = decodeURIComponent(portalRevoke[1]);
        if (!repo.getUser(db, id)) return sendJson(res, 404, { error: '人员不存在' }, origin, allowedOrigins);
        inTransaction(db, () => {
          repo.revokePortalAccess(db, id);
          repo.insertAudit(db, { id: randomUUID(), actor_user_id: session.userId, action: 'admin.portal_access_revoked',
            resource_type: 'app_user', resource_id: id, details_json: '{}', created_at: new Date().toISOString() });
        });
        return sendJson(res, 200, { ok: true }, origin, allowedOrigins);
      } catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : '撤销失败' }, origin, allowedOrigins); }
    }

    if (pathname === '/api/v1/admin/crm' || pathname.startsWith('/api/v1/admin/crm/')) {
      try {
        const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
        const result = crmRequest(db, pathname, req.method ?? 'GET', body, session.userId);
        return sendJson(res, result.status, result.body, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, error instanceof CrmError ? error.status : 400, { error: error instanceof Error ? error.message : '请求失败' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/admin/users' && req.method === 'GET') {
      const users = repo.listUsers(db);
      const usersById = new Map(users.map((user) => [user.id, user]));
      return sendJson(res, 200, {
        directory: {
          source: 'admin_roster_with_wecom_binding',
          fullSync: false,
          notice: '由后台维护人员档案。员工首次私聊机器人输入一次性绑定码，确认后自动关联企微账号。',
        },
        roles: ROLE_OPTIONS,
        users: users.map((user) => directoryUserView(db, user, usersById)),
      }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/users' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const department = typeof body.department === 'string' ? body.department.trim() : '';
        const role = roleFrom(body.role) ?? 'employee';
        const managerUserId = typeof body.managerUserId === 'string' && body.managerUserId.trim() ? body.managerUserId.trim() : null;
        if (!name) throw new Error('姓名不能为空');
        if (name.length > 64 || department.length > 64) throw new Error('姓名或部门不能超过64个字符');
        const manager = managerUserId ? repo.getUser(db, managerUserId) : undefined;
        if (managerUserId && !manager) throw new Error('所选上级不存在');
        if (manager?.role === 'employee') throw new Error('员工角色不能被设为上级');
        const id = randomUUID();
        const result = inTransaction(db, () => {
          const user = repo.upsertUser(db, {
            id, wecom_userid: `pending:${id}`, name, department, role, manager_user_id: managerUserId,
          });
          const activation = issueActivationCode(db, id);
          repo.insertAudit(db, {
            id: randomUUID(), actor_user_id: session.userId, action: 'admin.user_created',
            resource_type: 'app_user', resource_id: id,
            details_json: JSON.stringify({ name, department, role, managerUserId }), created_at: new Date().toISOString(),
          });
          return { user, activation };
        });
        const users = repo.listUsers(db);
        return sendJson(res, 201, {
          user: directoryUserView(db, result.user, new Map(users.map((user) => [user.id, user]))),
          activationCode: result.activation.code,
          activationExpiresAt: result.activation.expiresAt,
        }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    const userAssignmentMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
    if (userAssignmentMatch && req.method === 'PUT') {
      try {
        const body = await readJson(req);
        const id = decodeURIComponent(userAssignmentMatch[1]);
        const existing = repo.getUser(db, id);
        if (!existing) return sendJson(res, 404, { error: '企微成员不存在或尚未被识别' }, origin, allowedOrigins);
        const role = roleFrom(body.role);
        const displayName = typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim()
          : undefined;
        const department = typeof body.department === 'string' ? body.department.trim() : undefined;
        const managerUserId = typeof body.managerUserId === 'string' && body.managerUserId.trim() ? body.managerUserId.trim() : null;
        if (!role) throw new Error('请选择有效角色');
        if (displayName && displayName.length > 64) throw new Error('显示姓名不能超过64个字符');
        if (department && department.length > 64) throw new Error('部门不能超过64个字符');
        if (managerUserId === id) throw new Error('上级不能选择本人');
        const manager = managerUserId ? repo.getUser(db, managerUserId) : undefined;
        if (managerUserId && !manager) throw new Error('所选上级不存在');
        if (manager?.role === 'employee') throw new Error('员工角色不能被设为上级');
        const currentUsersById = new Map(repo.listUsers(db).map((entry) => [entry.id, entry]));
        if (managerUserId && createsReportingCycle(currentUsersById, id, managerUserId)) throw new Error('汇报关系不能形成循环');
        if (role === 'employee' && repo.countDirectReports(db, id) > 0) {
          throw new Error('该成员仍有直属人员，请先调整他们的汇报关系');
        }
        const user = inTransaction(db, () => {
          const updated = repo.updateUserAssignment(db, id, role, managerUserId, app.tenantId, displayName, department)!;
          if (existing.role !== role) repo.revokePortalAccess(db, id, app.tenantId);
          repo.insertAudit(db, {
            id: randomUUID(), actor_user_id: session.userId, action: 'admin.user_assignment_updated',
            resource_type: 'app_user', resource_id: updated.id,
            details_json: JSON.stringify({
              previousRole: existing.role,
              previousManagerUserId: existing.manager_user_id,
              role,
              managerUserId,
              displayNameChanged: Boolean(displayName && displayName !== existing.name),
              departmentChanged: department != null && department !== existing.department,
            }),
            created_at: new Date().toISOString(),
          });
          return updated;
        });
        const users = repo.listUsers(db);
        const usersById = new Map(users.map((entry) => [entry.id, entry]));
        return sendJson(res, 200, { user: directoryUserView(db, user, usersById) }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    const activationMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)\/activation-code$/);
    if (activationMatch && req.method === 'POST') {
      try {
        const id = decodeURIComponent(activationMatch[1]);
        const user = repo.getUser(db, id);
        if (!user) return sendJson(res, 404, { error: '人员不存在' }, origin, allowedOrigins);
        const activation = issueActivationCode(db, id);
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: session.userId, action: 'admin.activation_code_issued',
          resource_type: 'app_user', resource_id: id,
          details_json: JSON.stringify({ expiresAt: activation.expiresAt }), created_at: new Date().toISOString(),
        });
        return sendJson(res, 201, { activationCode: activation.code, activationExpiresAt: activation.expiresAt }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    const unbindMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)\/unbind$/);
    if (unbindMatch && req.method === 'POST') {
      try {
        const id = decodeURIComponent(unbindMatch[1]);
        const existing = repo.getUser(db, id);
        if (!existing) return sendJson(res, 404, { error: '人员不存在' }, origin, allowedOrigins);
        const result = inTransaction(db, () => {
          const user = repo.unbindUser(db, id)!;
          repo.revokePortalAccess(db, id);
          const activation = issueActivationCode(db, id);
          repo.insertAudit(db, {
            id: randomUUID(), actor_user_id: session.userId, action: 'admin.user_unbound',
            resource_type: 'app_user', resource_id: id,
            details_json: JSON.stringify({ activationExpiresAt: activation.expiresAt }), created_at: new Date().toISOString(),
          });
          return { user, activation };
        });
        const users = repo.listUsers(db);
        return sendJson(res, 200, {
          user: directoryUserView(db, result.user, new Map(users.map((user) => [user.id, user]))),
          activationCode: result.activation.code,
          activationExpiresAt: result.activation.expiresAt,
        }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/admin/items' && req.method === 'GET') {
      const userId = url.searchParams.get('userId') ?? '';
      const selectedWeek = url.searchParams.get('weekId') ?? defaultWeek;
      return sendJson(res, 200, { userId, weekId: selectedWeek, items: repo.listWorkItems(db, userId, selectedWeek) }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/items' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const userId = typeof body.userId === 'string' ? body.userId : '';
        const selectedWeek = typeof body.weekId === 'string' ? body.weekId : '';
        const items = Array.isArray(body.items) ? body.items.flatMap((item) => {
          if (typeof item === 'string') return [{ name: item, planBackground: '' }];
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          return typeof entry.name === 'string'
            ? [{ name: entry.name, planBackground: typeof entry.planBackground === 'string' ? entry.planBackground : '' }]
            : [];
        }) : [];
        if (!userId) throw new Error('缺少userId');
        app.createWeeklyPlan(userId, selectedWeek, items);
        return sendJson(res, 201, { items: repo.listWorkItems(db, userId, selectedWeek) }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    const itemMatch = pathname.match(/^\/api\/v1\/admin\/items\/([^/]+)$/);
    if (itemMatch && req.method === 'PUT') {
      try {
        const body = await readJson(req);
        const expectedVersion = Number(body.version);
        const name = typeof body.name === 'string' ? body.name : '';
        const planBackground = typeof body.planBackground === 'string' ? body.planBackground : '';
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('事项版本无效');
        const item = app.updateWeeklyPlanItem(session.userId, decodeURIComponent(itemMatch[1]), expectedVersion, { name, planBackground });
        return sendJson(res, 200, { item }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (itemMatch && req.method === 'DELETE') {
      try {
        const body = await readJson(req);
        const expectedVersion = Number(body.version);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('事项版本无效');
        app.deleteWeeklyPlanItem(session.userId, decodeURIComponent(itemMatch[1]), expectedVersion);
        return sendJson(res, 200, { ok: true }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/admin/daily-reports' && req.method === 'GET') {
      const reports = db.prepare(`
        SELECT d.*, u.name AS user_name,
          (SELECT COUNT(1) FROM daily_report_source s WHERE s.daily_report_id=d.id) AS source_count
        FROM daily_report d JOIN app_user u ON u.id=d.user_id
        WHERE d.tenant_id='poc' ORDER BY d.report_date DESC, d.version DESC LIMIT 200
      `).all();
      const sources = db.prepare(`
        SELECT s.id, s.msg_id, s.user_id, u.name AS user_name, s.report_date, s.content_type,
               s.text_content, s.process_status, s.process_error, s.created_at
        FROM source_message s JOIN app_user u ON u.id=s.user_id
        WHERE s.tenant_id='poc' ORDER BY s.created_at DESC LIMIT 500
      `).all();
      return sendJson(res, 200, { reports, sources }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/weekly-reports' && req.method === 'GET') {
      const reports = db.prepare(`
        SELECT w.*, u.name AS user_name,
          (SELECT COUNT(1) FROM manager_feedback f WHERE f.weekly_report_id=w.id) AS feedback_count
        FROM weekly_report w JOIN app_user u ON u.id=w.user_id
        WHERE w.tenant_id='poc' ORDER BY w.week_id DESC, w.version DESC LIMIT 200
      `).all();
      return sendJson(res, 200, { reports }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/templates' && req.method === 'GET') {
      return sendJson(res, 200, { templates: repo.listTemplates(db) }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/templates' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const kind = body.kind === 'daily' || body.kind === 'weekly' ? body.kind : undefined;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const content = typeof body.content === 'string' ? body.content : '';
        if (!kind || !name) throw new Error('模板类型和名称不能为空');
        const parsed = JSON.parse(content) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模板结构无效');
        const collection = kind === 'daily'
          ? (parsed as { fields?: unknown }).fields
          : (parsed as { sections?: unknown }).sections;
        if (!Array.isArray(collection) || collection.length === 0 || collection.length > 20) {
          throw new Error(kind === 'daily' ? '日报模板至少需要一个字段' : '周报模板至少需要一个章节');
        }
        const template = repo.createTemplateVersion(db, {
          id: randomUUID(), kind, name, content, created_at: new Date().toISOString(),
        });
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: session.userId, action: 'admin.template_version_created',
          resource_type: 'report_template', resource_id: template.id,
          details_json: JSON.stringify({ kind, version: template.version }), created_at: new Date().toISOString(),
        });
        return sendJson(res, 201, { template }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/admin/directory' || pathname === '/api/v1/admin/directory/sync') {
      try {
        if (pathname.endsWith('/sync') && req.method === 'POST') return sendJson(res, 200, await directory.sync(session.userId), origin, allowedOrigins);
        if (!pathname.endsWith('/sync') && req.method === 'GET') return sendJson(res, 200, directory.status(), origin, allowedOrigins);
        if (!pathname.endsWith('/sync') && req.method === 'PUT') {
          const body = await readJson(req);
          return sendJson(res, 200, directory.configure(body.url, session.userId, body.companyUrl), origin, allowedOrigins);
        }
        return sendJson(res, 405, { error: 'method_not_allowed' }, origin, allowedOrigins);
      } catch (error) { return sendJson(res, error instanceof DirectoryBusyError ? 409 : 400, { error: error instanceof Error ? error.message : '名录同步失败' }, origin, allowedOrigins); }
    }

    if (pathname === '/api/v1/admin/settings' && req.method === 'GET') {
      return sendJson(res, 200, {
        weekBoundary: app.weekBoundary,
        maxWorkItems: app.maxWorkItems,
        confirmPolicy: repo.getConfig(db, 'confirmPolicy', defaults.confirmPolicy),
        progressMode: repo.getConfig(db, 'progressMode', defaults.progressMode),
        planReminderAt: repo.getConfig(db, 'planReminderAt', defaults.schedule.planReminderAt),
        dailyReminderAt: repo.getConfig(db, 'dailyReminderAt', defaults.schedule.dailyReminderAt),
        weeklyGenerateAt: repo.getConfig(db, 'weeklyGenerateAt', defaults.schedule.weeklyGenerate.time),
        sourceRetentionDays: repo.getConfig(db, 'sourceRetentionDays', defaults.retention.sourceDays),
        attachmentRetentionDays: repo.getConfig(db, 'attachmentRetentionDays', defaults.retention.attachmentDays),
      }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/settings' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        if (body.weekBoundary !== 'natural_week' && body.weekBoundary !== 'work_week') throw new Error('周周期配置无效');
        const maxWorkItems = Number(body.maxWorkItems);
        if (!Number.isInteger(maxWorkItems) || maxWorkItems < 1 || maxWorkItems > 100) throw new Error('事项上限必须为1到100');
        const currentConfirmPolicy = repo.getConfig(db, 'confirmPolicy', defaults.confirmPolicy);
        const currentProgressMode = repo.getConfig(db, 'progressMode', defaults.progressMode);
        const confirmPolicy = body.confirmPolicy == null ? currentConfirmPolicy
          : body.confirmPolicy === 'button_only' ? 'button_only' : 'button_and_text';
        const progressMode = body.progressMode == null ? currentProgressMode
          : body.progressMode === 'incremental' || body.progressMode === 'subitem' ? body.progressMode : 'cumulative';
        const planReminderCandidate = body.planReminderAt == null
          ? repo.getConfig(db, 'planReminderAt', defaults.schedule.planReminderAt)
          : body.planReminderAt;
        const dailyReminderCandidate = body.dailyReminderAt == null
          ? repo.getConfig(db, 'dailyReminderAt', defaults.schedule.dailyReminderAt)
          : body.dailyReminderAt;
        const weeklyGenerateCandidate = body.weeklyGenerateAt == null
          ? repo.getConfig(db, 'weeklyGenerateAt', defaults.schedule.weeklyGenerate.time)
          : body.weeklyGenerateAt;
        const planReminderAt = typeof planReminderCandidate === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(planReminderCandidate)
          ? planReminderCandidate : undefined;
        const dailyReminderAt = typeof dailyReminderCandidate === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(dailyReminderCandidate)
          ? dailyReminderCandidate : undefined;
        const weeklyGenerateAt = typeof weeklyGenerateCandidate === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(weeklyGenerateCandidate)
          ? weeklyGenerateCandidate : undefined;
        const sourceRetentionDays = Number(body.sourceRetentionDays ?? repo.getConfig(db, 'sourceRetentionDays', defaults.retention.sourceDays));
        const attachmentRetentionDays = Number(body.attachmentRetentionDays ?? repo.getConfig(db, 'attachmentRetentionDays', defaults.retention.attachmentDays));
        if (!planReminderAt || !dailyReminderAt || !weeklyGenerateAt) throw new Error('提醒时间格式无效');
        if (!Number.isInteger(sourceRetentionDays) || sourceRetentionDays < 30 || sourceRetentionDays > 3650) throw new Error('原始记录留存应为30到3650天');
        if (!Number.isInteger(attachmentRetentionDays) || attachmentRetentionDays < 7 || attachmentRetentionDays > 3650) throw new Error('附件留存应为7到3650天');
        repo.setConfig(db, 'weekBoundary', body.weekBoundary);
        repo.setConfig(db, 'maxWorkItems', maxWorkItems);
        repo.setConfig(db, 'confirmPolicy', confirmPolicy);
        repo.setConfig(db, 'progressMode', progressMode);
        repo.setConfig(db, 'planReminderAt', planReminderAt);
        repo.setConfig(db, 'dailyReminderAt', dailyReminderAt);
        repo.setConfig(db, 'weeklyGenerateAt', weeklyGenerateAt);
        repo.setConfig(db, 'sourceRetentionDays', sourceRetentionDays);
        repo.setConfig(db, 'attachmentRetentionDays', attachmentRetentionDays);
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: session.userId, action: 'admin.settings_updated',
          resource_type: 'app_config', resource_id: 'business-rules',
          details_json: JSON.stringify({
            weekBoundary: body.weekBoundary, maxWorkItems, confirmPolicy, progressMode,
            planReminderAt, dailyReminderAt, weeklyGenerateAt, sourceRetentionDays, attachmentRetentionDays,
          }), created_at: new Date().toISOString(),
        });
        return sendJson(res, 200, {
          weekBoundary: app.weekBoundary, maxWorkItems: app.maxWorkItems, confirmPolicy, progressMode,
          planReminderAt, dailyReminderAt, weeklyGenerateAt, sourceRetentionDays, attachmentRetentionDays,
        }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/admin/knowledge' && req.method === 'GET') {
      const kind = knowledgeKind(url.searchParams.get('kind'));
      const query = url.searchParams.get('query') ?? undefined;
      return sendJson(res, 200, { entries: repo.listKnowledgeEntries(db, { kind, query }) }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/knowledge' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const kind = knowledgeKind(body.kind);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        const sourceName = typeof body.sourceName === 'string' ? body.sourceName.trim() : '';
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean).slice(0, 20)
          : [];
        if (!kind || !title) throw new Error('请选择资料类型并填写名称');
        if (!content) throw new Error('资料内容不能为空');
        if (title.length > 120 || summary.length > 500 || content.length > 50_000) throw new Error('资料内容超过长度限制');
        const now = new Date().toISOString();
        const entry = repo.createKnowledgeEntry(db, {
          id: randomUUID(), kind, title, summary, content, tags_json: JSON.stringify(tags), source_name: sourceName,
          created_at: now, updated_at: now,
        });
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: session.userId, action: 'admin.knowledge_created',
          resource_type: 'knowledge_entry', resource_id: entry.id,
          details_json: JSON.stringify({ kind, title }), created_at: now,
        });
        return sendJson(res, 201, { entry }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    const knowledgeMatch = pathname.match(/^\/api\/v1\/admin\/knowledge\/([^/]+)$/);
    if (knowledgeMatch && req.method === 'PUT') {
      try {
        const body = await readJson(req);
        const id = decodeURIComponent(knowledgeMatch[1]);
        const existing = repo.getKnowledgeEntry(db, id);
        if (!existing) return sendJson(res, 404, { error: '资料不存在' }, origin, allowedOrigins);
        const kind = knowledgeKind(body.kind) ?? existing.kind;
        const title = typeof body.title === 'string' ? body.title.trim() : existing.title;
        const summary = typeof body.summary === 'string' ? body.summary.trim() : existing.summary;
        const content = typeof body.content === 'string' ? body.content.trim() : existing.content;
        const sourceName = typeof body.sourceName === 'string' ? body.sourceName.trim() : existing.source_name;
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean).slice(0, 20)
          : JSON.parse(existing.tags_json);
        const active = body.active === false || body.active === 0 ? 0 : 1;
        const expectedVersion = Number(body.version);
        if (!title || !content) throw new Error('名称和内容不能为空');
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('资料版本无效');
        const now = new Date().toISOString();
        const entry = repo.updateKnowledgeEntry(db, id, expectedVersion, {
          kind, title, summary, content, source_name: sourceName, tags_json: JSON.stringify(tags), active,
        }, now);
        if (!entry) return sendJson(res, 409, { error: '资料已被更新，请刷新后重试' }, origin, allowedOrigins);
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: session.userId, action: 'admin.knowledge_updated',
          resource_type: 'knowledge_entry', resource_id: id,
          details_json: JSON.stringify({ kind, title, active, version: entry.version }), created_at: now,
        });
        return sendJson(res, 200, { entry }, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/admin/audit-logs' && req.method === 'GET') {
      const logs = db.prepare(`
        SELECT a.*, u.name AS actor_name
        FROM audit_log a LEFT JOIN app_user u ON u.id=a.actor_user_id AND u.tenant_id=a.tenant_id
        WHERE a.tenant_id='poc' ORDER BY a.created_at DESC LIMIT 500
      `).all();
      return sendJson(res, 200, { logs }, origin, allowedOrigins);
    }

    if (pathname === '/api/v1/admin/exports' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
        const year = body.year == null ? currentYear : Number(body.year);
        const quarter = body.quarter == null || body.quarter === '' ? null : Number(body.quarter);
        const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null;
        if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('导出年份无效');
        if (quarter != null && (!Number.isInteger(quarter) || quarter < 1 || quarter > 4)) throw new Error('季度必须为1到4');
        if (userId && !repo.getUser(db, userId)) throw new Error('导出人员不存在');
        const archive=buildStructuredArchive(db,{...session,tenantId:'poc'},{year,quarter,userId});
        const now = new Date().toISOString();
        repo.insertAudit(db, {
          id: randomUUID(), actor_user_id: session.userId, action: 'admin.archive_exported',
          resource_type: 'archive_export', resource_id: `${year}${quarter ? `-Q${quarter}` : ''}${userId ? `:${userId}` : ''}`,
          details_json: JSON.stringify({ year, quarter, userId }), created_at: now,
        });
        return sendJson(res, 200, archive, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (pathname === '/api/v1/dashboard' && req.method === 'GET') {
      if (session.resourceId) return sendJson(res, 403, { error: 'resource_scoped_session' }, origin, allowedOrigins);
      const selectedWeek = url.searchParams.get('weekId') ?? defaultWeek;
      const sunday = sundayOf(dateAt(selectedWeek));
      const visibleUsers = repo.listUsers(db).filter((user) => userCanRead(session, user.id, db));
      const employees = visibleUsers.map((user) => {
        const items = repo.listWorkItems(db, user.id, selectedWeek);
        const reports = repo.listDailyReportsInRange(db, user.id, selectedWeek, sunday).filter(report=>repo.isGeneratedReportReadable(db,user.id,report.id,'daily'));
        const progress = itemProgressView(items, reports);
        const confirmedDays = new Set(reports.filter((report) => report.status === 'confirmed').map((report) => report.report_date));
        const weekly = repo.getWeeklyReport(db, user.id, selectedWeek);
        const missingDays = weekly ? (JSON.parse(weekly.missing_days_json) as string[]) : [];
        const expectedDays = app.weekBoundary === 'work_week' ? 5 : 7;
        return {
          userId: user.id,
          name: user.name,
          workItemCount: items.length,
          itemNames: items.map((item) => item.name),
          confirmedDays: confirmedDays.size,
          missingDays: missingDays.length,
          submissionRate: Math.round((confirmedDays.size / expectedDays) * 100),
          completionRate: progress.length
            ? Math.round(progress.reduce((sum, item) => sum + item.progressValue, 0) / progress.length)
            : 0,
          itemProgress: progress,
        };
      });
      return sendJson(res, 200, { weekId: selectedWeek, employees }, origin, allowedOrigins);
    }

    const reportMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
    if (reportMatch && req.method === 'GET') {
      const [, encodedUserId, selectedWeek] = reportMatch;
      const userId = decodePathSegment(encodedUserId);
      if (!userId) return sendJson(res, 400, { error: 'bad_request' }, origin, allowedOrigins);
      if (!userCanRead(session, userId, db)) return sendJson(res, 403, { error: 'forbidden' }, origin, allowedOrigins);
      const weekly = session.resourceId
        ? repo.getWeeklyReportById(db, session.resourceId)
        : repo.getWeeklyReport(db, userId, selectedWeek);
      if (!weekly) return sendJson(res, 404, { error: 'not_found' }, origin, allowedOrigins);
      if (weekly.user_id !== userId || weekly.week_id !== selectedWeek) return sendJson(res, 403, { error: 'forbidden' }, origin, allowedOrigins);
      if(!repo.isGeneratedReportReadable(db,userId,weekly.id,'weekly')) return sendJson(res,403,{error:'引用资料权限或版本已变化，请重新生成；历史原文仍归档保留'},origin,allowedOrigins);
      let citedIds: string[] = [];
      try {
        const parsed = JSON.parse(weekly.cited_report_ids_json) as unknown;
        if (Array.isArray(parsed)) citedIds = parsed.filter((value): value is string => typeof value === 'string');
      } catch { citedIds = []; }
      const reports = citedIds
        .map((id) => repo.getDailyReportById(db, id))
        .filter((report): report is repo.DailyReportRow => Boolean(report && report.user_id === userId))
        .sort((left, right) => left.report_date.localeCompare(right.report_date));
      let snapshotItems: Array<{ id: string; name: string; plan_background: string }> = [];
      try {
        const parsed = JSON.parse(weekly.item_snapshot_json) as unknown;
        if (Array.isArray(parsed)) {
          snapshotItems = parsed.flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const entry = item as Record<string, unknown>;
            return typeof entry.id === 'string' && typeof entry.name === 'string'
              ? [{ id: entry.id, name: entry.name, plan_background: typeof entry.planBackground === 'string' ? entry.planBackground : '' }]
              : [];
          });
        }
      } catch { snapshotItems = []; }
      const items = snapshotItems.length ? snapshotItems : repo.listWorkItems(db, userId, weekly.week_id);
      // The outer route has checked both user/week and the exact report-scoped grant.
      const detail=getWeeklyDetail(db,{userId:session.userId,role:session.role,tenantId:'poc'},userId,weekly.week_id,{reportId:weekly.id});
      const feedback = detail.feedback;
      repo.insertAudit(db, {
        id: randomUUID(), actor_user_id: session.userId, action: 'weekly_report.viewed',
        resource_type: 'weekly_report', resource_id: weekly.id,
        details_json: JSON.stringify({ resourceScoped: Boolean(session.resourceId) }), created_at: new Date().toISOString(),
      });
      return sendJson(res, 200, {
        id: weekly.id,
        version:weekly.version,
        generatedAt:weekly.generated_at,
        progressSnapshot:detail.evidence?.progressSnapshot??null,
        sourceSnapshot:detail.evidence?.snapshot??null,
        userId,
        name: repo.getUser(db, userId)?.name ?? userId,
        weekId: weekly.week_id,
        content: weekly.content,
        sections: JSON.parse(weekly.sections_json),
        missingDays: JSON.parse(weekly.missing_days_json),
        reports,
        itemProgress: itemProgressView(items, reports, false),
        feedback,
        canFeedback: userId !== session.userId && (session.role === 'admin' || session.role === 'dept_head' || session.role === 'team_lead'),
      }, origin, allowedOrigins);
    }

    const feedbackMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/feedback$/);
    if (feedbackMatch && (req.method === 'POST'||req.method==='PUT')) {
      const [, encodedUserId, selectedWeek] = feedbackMatch;
      const userId = decodePathSegment(encodedUserId);
      if (!userId) return sendJson(res, 400, { error: 'bad_request' }, origin, allowedOrigins);
      if (session.role !== 'admin' && session.role !== 'dept_head' && session.role !== 'team_lead') {
        return sendJson(res, 403, { error: 'forbidden' }, origin, allowedOrigins);
      }
      if (!userCanRead(session, userId, db) || userId === session.userId) return sendJson(res, 403, { error: 'forbidden' }, origin, allowedOrigins);
      try {
        const body = await readJson(req);
        const reportId=session.resourceId??(typeof body.reportId==='string'?body.reportId:'');
        if(!reportId) throw new Error('请刷新周报后对指定版本反馈');
        if(body.reportId&&body.reportId!==reportId) return sendJson(res,403,{error:'报告限定入口不能反馈另一份报告'},origin,allowedOrigins);
        const weekly=repo.getWeeklyReportById(db,reportId);
        if(!weekly) return sendJson(res,404,{error:'not_found'},origin,allowedOrigins);
        if(weekly.user_id!==userId||weekly.week_id!==selectedWeek) return sendJson(res,403,{error:'forbidden'},origin,allowedOrigins);
        const content = typeof body.content === 'string' ? body.content : '';
        const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
        if(!key) throw new Error('缺少请求标识');
        const result=saveWeeklyFeedback(db,{userId:session.userId,role:session.role,tenantId:'poc'},{weeklyReportId:weekly.id,content,idempotencyKey:key,
          ...(req.method==='PUT'?{feedbackId:typeof body.feedbackId==='string'?body.feedbackId:'',expectedVersion:body.expectedVersion as number}: {})});
        return sendJson(res, req.method==='POST'?201:200, result, origin, allowedOrigins);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad_request' }, origin, allowedOrigins);
      }
    }

    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
    return sendJson(res, 404, { error: 'not_found' }, origin, allowedOrigins);
  });
  server.once('close', () => db.close());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`日报助手 API：http://${host}:${actualPort}`);
  return server;
}
