# 新服务器部署与交接

## 状态

这是待新服务器联调的部署方案，不是生产部署成功记录。运行环境为 Linux + Docker Engine/Compose + HTTPS反向代理。建议先独立测试域名验收，使用新机器人、新授权和新表格；不要直接接入正在运行的同一 Bot ID。

## 1. 准备

需要服务器 SSH 管理权限、指向服务器的域名、TLS证书/自动签发能力、企微机器人凭据、企微文档授权及可调用的模型账号。服务器需要允许访问企微和模型/检索服务。防火墙只对外开放反向代理所需端口，SSH按来源限制。

```bash
git clone https://github.com/flyman008/wecom-daily-assistant.git
cd wecom-daily-assistant
mkdir -p .runtime/data .runtime/attachments .runtime/backups .runtime/wecom-cli
cp .env.example .runtime/wecom.env
chmod 700 .runtime
chmod 600 .runtime/wecom.env
```

运行容器的用户是镜像内 `node`（UID1000），绑定目录必须给予该用户必要权限。仅对本项目新建的 `.runtime` 调整属主，不对服务器其他业务目录递归修改。

```bash
sudo chown -R 1000:1000 .runtime
```

## 2. 配置

在服务器本地安全编辑 `.runtime/wecom.env`，不上传Git：

- `WECOM_BOT_ID`、`WECOM_BOT_SECRET`：新实例专用。
- `API_HOST=0.0.0.0`、`PORT=3000`：供容器网络使用，Compose仅映射到主机127.0.0.1。
- `POC_ACCESS_CODE`：生成强随机值，即使不使用PC后台也要配置。
- `REPORT_BASE_URL=https://你的域名`、`API_ALLOWED_ORIGINS=https://你的域名`。
- `WECOM_CLI_ENTRY=/usr/local/lib/node_modules/@wecom/cli/bin/wecom.js`。
- `AGENT_PROVIDER=openai_compatible`及对应模型地址、模型名、密钥；未配置真实模型时只能Mock。
- `WEEK_BOUNDARY=natural_week`及提醒时间；容器时区为Asia/Shanghai。
- `PUBLIC_WEEKLY_USER_NAME`、`PUBLIC_WEEKLY_EMPLOYEE_NAME`默认留空。它们是演示公开身份入口，只能在人员已初始化且接受公开访问风险后开启，不能当成正式鉴权方案。

如需新企业功能，复制 `config/new-companies.example.json` 到 `.runtime/new-companies.json`，填写新企业表和正式企业名录的链接。

## 3. 构建与初始化

```bash
docker compose build
docker compose run --rm api pnpm check
docker compose run --rm -e WECOM_CLI_CONFIG_DIR=/app/.runtime/wecom-cli api node /usr/local/lib/node_modules/@wecom/cli/bin/wecom.js --help
```

最后一条用于检查所安装版本的授权指令（如命令入口不同，使用 `node /usr/local/lib/node_modules/@wecom/cli/bin/wecom.js --help`）。按该CLI版本帮助完成**新机器人独立授权**，并验证身份与Bot ID一致；不要复制个人电脑或其他企业的授权目录。

人员和企业需要先导入；标准模式设置 `DIRECTORY_SHEET_URL` 后执行 `docker compose run --rm api pnpm directory:sync`。极简两表的企业链接目前保存在本地业务配置中，尚缺完全独立的无后台配置命令，正式客户不要依赖此模式。

```bash
docker compose up -d api
curl -f http://127.0.0.1:3000/api/v1/health
# 确认旧网关已停、新机器人凭据及文档授权准备好后
docker compose up -d gateway
docker compose ps
docker compose logs --tail=100 api gateway
```

原有用户初始化、绑定码分发、模型实调和企微表字段必须实施验收，不是启动容器就自动完成。

## 4. 域名与HTTPS

使用服务器已有的Nginx/Caddy等将HTTPS域名反向代理到 `127.0.0.1:3000`。不要把API3000、SQLite目录或网关8788直接暴露公网。保留访问日志，但避免把分享令牌和敏感查询参数记录到日志。

域名和HTTPS能避免裸IP链接对应的问题，但不能保证企微永远不出现任何外链提醒。是否需额外企业配置以目标企业实测为准。网页授权不是当前项目必须引入的登录方案；公开查看与写反馈权限应分开设计。

## 5. 验收清单

- API健康、网关健康与企微连接正常，容器重启后恢复。
- 真实员工绑定、计划输入、日报修改确认、无重复累计。
- 已知企业正确关联；未知企业搜索、补充确认、企微表回读一致。
- 手机上打开员工/团队周报，周次和数据范围正确。
- 页面反馈保存原文，员工收到一次提醒；失败发送可以排查，不盲目重发。
- 文档授权过期、模型失败、网络中断时有明确提示，不丢原始记录。
- 验证公开链接是否泄露非目标范围数据，以及访客能否伪造管理者反馈；通过前不开放真实数据。

## 6. 备份、更新与回滚

```bash
docker compose exec api pnpm backup
```

将 `.runtime/backups` 和必要附件加密备份到独立位置；企微文档需要单独的导出/版本保留策略。授权和密钥备份要单独控制权限。不要运行 `docker compose down -v` 或清理数据库目录。

更新前记录当前Git提交、执行备份、完成测试，再构建和重建相关容器。回滚应在干净部署副本检出已验收提交并重新构建；若有不兼容数据库迁移，必须同时按预案恢复数据库。不要对开发者脏工作区执行强制重置。

## 7. 本次验证边界

本地源码检查和测试结果记录在仓库提交说明/交付消息中。整理机器没有Docker，未完成镜像构建、Linux容器启动、真实模型请求和新企微企业端到端验收；GitHub CI会补充Linux源码测试，但它也不替代业务验收。
