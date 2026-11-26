import { X } from 'lucide-react';
import type { ReactElement } from 'react';

export type ImagePreviewDialogProps = {
  readonly previewImage: { readonly mediaType: string; readonly data: string };
  readonly setPreviewImage: (image: null) => void;
};

/** Full-screen preview of an attached or message image. */
export function ImagePreviewDialog({
  previewImage,
  setPreviewImage,
}: ImagePreviewDialogProps): ReactElement {
  return (
    <div
      className="image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setPreviewImage(null);
        }
      }}
    >
      <button
        className="image-preview-close"
        type="button"
        aria-label="关闭预览"
        onClick={() => setPreviewImage(null)}
      >
        <X aria-hidden="true" />
      </button>
      <img
        className="image-preview-image"
        src={`data:${previewImage.mediaType};base64,${previewImage.data}`}
        alt="图片预览"
      />
    </div>
  );
}
