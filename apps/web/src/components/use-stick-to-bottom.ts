import { type RefObject, useEffect } from "react";

/** How close to the bottom, in pixels, still counts as reading the latest output. */
const nearBottomThresholdInPixels = 80;

/**
 * Keeps the page scrolled to the bottom as the observed element grows, but
 * only while the reader is already at the bottom, so scrolling up to read
 * earlier output is not interrupted by text streaming in.
 */
export function useStickToBottom(elementReference: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = elementReference.current;
    if (element === null) {
      return;
    }
    let isNearBottom = true;
    const measureScrollPosition = () => {
      const distanceFromBottom =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      isNearBottom = distanceFromBottom < nearBottomThresholdInPixels;
    };
    const sizeObserver = new ResizeObserver(() => {
      if (isNearBottom) {
        window.scrollTo({ top: document.documentElement.scrollHeight });
      }
    });
    sizeObserver.observe(element);
    window.addEventListener("scroll", measureScrollPosition, { passive: true });
    return () => {
      sizeObserver.disconnect();
      window.removeEventListener("scroll", measureScrollPosition);
    };
  }, [elementReference]);
}
