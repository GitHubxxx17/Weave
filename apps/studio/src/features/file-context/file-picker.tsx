import { useEffect, useRef, type ReactElement } from 'react';
import type { FilePickerController } from './use-file-picker.js';
export function FilePicker({
  picker,
}: {
  readonly picker: FilePickerController;
}): ReactElement | null {
  const searchRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    if (picker.open && picker.buttonMode) searchRef.current?.focus();
  }, [picker.open, picker.buttonMode]);
  if (!picker.open) return null;
  return (
    <section className="file-picker" aria-label="添加项目文件">
      <div className="file-picker-heading">
        <strong>项目文件</strong>
        <button type="button" aria-label="关闭文件选择" onClick={picker.close}>
          关闭
        </button>
      </div>
      {picker.buttonMode ? (
        <input
          ref={searchRef}
          className="file-picker-search"
          type="text"
          aria-label="搜索项目文件"
          placeholder="搜索文件名或路径，支持空格"
          maxLength={256}
          value={picker.query}
          aria-controls={picker.listId}
          aria-activedescendant={
            picker.items.length === 0 ? undefined : picker.optionId(picker.activeIndex)
          }
          onChange={(event) => picker.setQuery(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (!composing.current) picker.handleKeyDown(event);
          }}
        />
      ) : null}
      {picker.noRoot ? (
        <p role="status">先设置项目文件夹</p>
      ) : picker.loading ? (
        <p role="status">正在读取项目文件…</p>
      ) : picker.error !== null ? (
        <p role="alert">{picker.error}</p>
      ) : null}
      <ul id={picker.listId} role="listbox" aria-label="项目文件候选">
        {picker.items.map((path, index) => (
          <li
            key={path}
            id={picker.optionId(index)}
            role="option"
            aria-selected={picker.activeIndex === index}
            aria-label={path}
            title={path}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => picker.setActiveIndex(index)}
            onClick={() => picker.select(path)}
          >
            {path}
          </li>
        ))}
      </ul>
      {!picker.noRoot && !picker.loading && picker.error === null && picker.items.length === 0 ? (
        <p role="status">没有匹配的文件</p>
      ) : null}
      {picker.truncated ? <p role="status">仅显示部分项目文件，可从文件树添加</p> : null}
    </section>
  );
}
