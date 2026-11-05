import { useEffect, useRef, useState } from 'react';

/** true while the element intersects the viewport. Without IntersectionObserver (jsdom), always true. */
export function useInView() {
  const ref = useRef(null);
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !ref.current) return undefined;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: '100px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, inView];
}
