import { useEffect, useState } from "react";
import { useFleet } from "../../store/useFleet.js";
import { useAlertActions } from "../AlertStack.js";

/** Full-width transient banner under the header for a new alert (5 s, tap to jump). */
export function Banner() {
  const banner = useFleet((s) => s.banner);
  const setBanner = useFleet((s) => s.setBanner);
  const setSheet = useFleet((s) => s.setSheet);
  const { jump } = useAlertActions();
  const [shown, setShown] = useState(banner);
  useEffect(() => {
    if (!banner) return;
    setShown(banner);
    const t = setTimeout(() => {
      setShown(null);
      setBanner(null);
    }, 5000);
    return () => clearTimeout(t);
  }, [banner, setBanner]);
  if (!shown) return null;
  return (
    <button
      type="button"
      className={`banner ${shown.kind}`}
      onClick={() => {
        jump(shown);
        setSheet("detail");
        setShown(null);
        setBanner(null);
      }}
    >
      <b>{shown.title}</b>
      <span>{shown.body}</span>
    </button>
  );
}
