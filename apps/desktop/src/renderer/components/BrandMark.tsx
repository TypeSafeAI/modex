const mark = new URL("../assets/modex-mark.png", import.meta.url).href;

/** The official mark keeps its original color in every app theme. */
export function BrandMark({ className = "" }: { className?: string }) {
  return <img src={mark} className={`brand-mark ${className}`} alt="" aria-hidden="true" draggable={false} />;
}
