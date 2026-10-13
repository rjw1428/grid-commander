import { useEffect, useState } from "react";

const q = "(pointer: coarse) and (max-width: 1024px)";

export function useIsMobile(): boolean {
  const compute = () => (typeof window === "undefined" ? false : window.matchMedia(q).matches || window.innerWidth < 720);
  const [mobile, setMobile] = useState(compute);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setMobile(compute());
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    return () => {
      mq.removeEventListener("change", on);
      window.removeEventListener("resize", on);
    };
  }, []);
  return mobile;
}

export function useReducedMotion(): boolean {
  const [rm, setRm] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setRm(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return rm;
}
