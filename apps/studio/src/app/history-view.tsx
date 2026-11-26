import { History } from 'lucide-react';
import type { ReactElement } from 'react';

export type HistoryViewProps = {
  readonly title: string;
  readonly description: string;
};

/** The "历史" page placeholder. */
export function HistoryView({ title, description }: HistoryViewProps): ReactElement {
  return (
    <>
      <header className="page-header">
        <div className="page-header-copy">
          <h2>{title}</h2>
          <p>{description}。</p>
        </div>
      </header>
      <div className="page-empty">
        <span className="page-empty-icon" aria-hidden="true">
          <History />
        </span>
        <strong>暂无历史记录</strong>
        <p>跨项目的运行记录与会话时间线还在开发中。</p>
      </div>
    </>
  );
}
