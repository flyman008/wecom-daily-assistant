import { describe, expect, it } from 'vitest';
import {
  activationIdFromBindingTask,
  bindingCancelledCard,
  bindingCompletedCard,
  bindingConfirmCard,
  bindingTaskId,
} from './binding-card';

describe('企微账号绑定卡片', () => {
  it('包含确认和取消两个明确动作且不显示绑定码', () => {
    const card = bindingConfirmCard('activation-1', '张三', '企业服务部');
    expect(card.card_type).toBe('button_interaction');
    expect(card.button_list?.map((button) => button.key)).toEqual(['confirm_binding', 'cancel_binding']);
    expect(JSON.stringify(card)).not.toContain('SN-');
    expect(activationIdFromBindingTask(bindingTaskId('activation-1'))).toBe('activation-1');
  });

  it('确认和取消后都转换为不可重复点击的通知卡片', () => {
    expect(bindingCompletedCard('binding_activation-1', '张三').card_type).toBe('text_notice');
    expect(bindingCancelledCard('binding_activation-1').card_type).toBe('text_notice');
  });
});
