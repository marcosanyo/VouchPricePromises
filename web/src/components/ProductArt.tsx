// Product picture: the category illustration, or a drawn bag when there is none.
import { productImage } from '../products';
import { Icon } from './Icon';

export function ProductArt({ title, size = 'md' }: { title?: string; size?: 'sm' | 'md' | 'lg' }) {
  const src = productImage(title);
  return src ? (
    <img className={`art art-${size}`} src={src} alt="" loading="lazy" />
  ) : (
    <div className={`art art-${size} art-empty`} aria-hidden="true">
      <Icon name="bag" size={size === 'sm' ? 22 : 44} />
    </div>
  );
}
