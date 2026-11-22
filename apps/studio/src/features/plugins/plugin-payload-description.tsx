import type { ReactElement } from 'react';

export const declarativeSkillDisclosure =
  '激活后，这些技能文本可作为 Agent 指令使用，引用资源按需读取。工具权限、工作区边界和审批规则继续适用；信任此文本包不会增加工具权限。';

export function DeclarativeSkillPayload(): ReactElement {
  return (
    <p className="plugin-note">
      <strong>Skills 文本包</strong> · <span>无可执行入口</span>
    </p>
  );
}

export function PluginPanelDisclosure(): ReactElement {
  return (
    <p className="plugin-note">
      右侧面板由宿主渲染；表单仅准备可编辑文本，需您点击发送。兼容的历史事件不证明其生成版本。
    </p>
  );
}
