import "./BrandMark.css";

const mark = new URL("../assets/modex-mark.png", import.meta.url).href;

/** Preserve the official silhouette; only Coven recolors it with its accent. */
export function BrandMark({ className = "" }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true"><img src={mark} alt="" draggable={false} /></span>;
}
