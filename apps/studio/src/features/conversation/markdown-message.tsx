import { memo, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

/** Only http(s) and mailto links are rendered as clickable links. */
function safeUrl(url: string): string {
  return /^(?:https?:|mailto:)/i.test(url) ? url : '';
}

const components: Components = {
  a: ({ href, children }) =>
    href !== undefined && href !== '' ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/**
 * Renders model output as GitHub-flavored Markdown.
 *
 * Raw HTML in the model output is not interpreted (react-markdown escapes it
 * by default and no rehype-raw plugin is installed), so a model cannot inject
 * scripts or arbitrary elements into Studio. Images are dropped so the model
 * cannot make Studio load remote resources, and only http(s)/mailto links are
 * kept.
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  text,
}: {
  readonly text: string;
}): ReactElement {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={safeUrl}
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
