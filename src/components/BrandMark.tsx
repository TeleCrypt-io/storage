const BRAND_MARK_URL = "https://www.telecrypt.io/logo-mark.png";

export function BrandMark() {
  return (
    <img
      className="tc-brand-mark"
      src={BRAND_MARK_URL}
      width={28}
      height={28}
      alt=""
      decoding="async"
    />
  );
}
