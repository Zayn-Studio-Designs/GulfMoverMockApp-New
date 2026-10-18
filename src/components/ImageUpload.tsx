import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useLanguage } from '../context/LanguageContext';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Shrinks an uploaded image so it fits comfortably in browser storage.
 * `crop` makes a centred square (profile photos); otherwise the whole image is kept (logos), as PNG to keep transparency.
 */
export function resizeImage(file: File, size: number, crop: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(String(reader.result)); return; }
        if (crop) {
          const side = Math.min(img.width, img.height);
          canvas.width = size; canvas.height = size;
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } else {
          const scale = Math.min(1, size / Math.max(img.width, img.height));
          canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Preview + upload/remove buttons for a single stored image (profile picture or company logo). */
export function ImageUpload({ label, preview, hasImage, size, crop, onChange, removeKey = 'removePhoto', uploadKey = 'uploadPhoto' }: {
  label: string; preview: ReactNode; hasImage: boolean; size: number; crop: boolean; onChange: (dataUrl: string) => void; removeKey?: string; uploadKey?: string;
}) {
  const { t } = useLanguage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError('photoType'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError('photoTooBig'); return; }
    setError('');
    try {
      onChange(await resizeImage(file, size, crop));
    } catch {
      setError('photoType');
    }
  };

  return (
    <div className="avatar-row">
      {preview}
      <div className="grid" style={{ gap: 8 }}>
        <span className="label">{label}</span>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline btn-small" onClick={() => fileRef.current?.click()}>{hasImage ? t('changeImage') : t(uploadKey)}</button>
          {hasImage && <button type="button" className="btn btn-outline btn-small" onClick={() => onChange('')}>{t(removeKey)}</button>}
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} aria-label={label} />
        <small className="muted small">{t('photoHint')}</small>
        {error && <small className="error-text" role="alert">{t(error)}</small>}
      </div>
    </div>
  );
}

/** Company logo, or a building-style placeholder with the company initials. */
export function CompanyLogo({ company, logo, size = 34 }: { company: string; logo: string; size?: number }) {
  const initials = company.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'CO';
  return logo
    ? <img className="company-logo" src={logo} alt="" style={{ width: size, height: size }} />
    : <span className="company-logo company-logo-empty" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.32) }}>{initials}</span>;
}
