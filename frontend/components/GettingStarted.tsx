"use client";

import { useEffect, useState } from "react";
import { Icon } from "./ui";

const KEY = "runofflab.gettingStarted.dismissed";

/** A three-step orientation shown until the viewer dismisses it. */
export default function GettingStarted({ onExplore }: { onExplore: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try { setShow(localStorage.getItem(KEY) !== "1"); } catch { setShow(true); }
  }, []);
  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem(KEY, "1"); } catch { /* storage unavailable */ }
  };
  return (
    <aside className="getting-started" aria-label="Getting started">
      <ol>
        <li><span className="gs-num">1</span><span><strong>Pick a design</strong> in the sidebar, or press <em>New</em>.</span></li>
        <li><span className="gs-num">2</span><span><strong>Draw</strong> rain gardens on lawns (<kbd>R</kbd>) and permeable pavement on parking (<kbd>P</kbd>).</span></li>
        <li><span className="gs-num">3</span><span><strong>Run comparison</strong> to see the effect, or let the{" "}
          <button className="link-btn" onClick={onExplore}>Design Explorer</button> find layouts for you.</span></li>
      </ol>
      <button className="btn sm ghost" onClick={dismiss} aria-label="Dismiss getting started">Got it</button>
    </aside>
  );
}
