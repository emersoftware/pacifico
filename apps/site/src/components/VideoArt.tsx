import { useEffect, useRef, useState } from 'react';

type Props = { mediaPath: string; locale: 'en' | 'es' };

export default function VideoArt({ mediaPath, locale }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const text =
    locale === 'es'
      ? {
          label: 'Olas rosadas con dithering, azules sobre blanco o blancas sobre negro',
          error: 'El video no pudo cargar.',
        }
      : { label: 'Dithered pink waves, blue on white or white on black', error: 'The video could not load.' };

  useEffect(() => {
    const media = video.current;
    const container = frame.current;
    if (!media || !container) return;
    let visible = false;
    let position = 0;
    let source = '';
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    function syncPlayback() {
      if (!media || !visible || document.hidden || reduced.matches) {
        media?.pause();
        if (reduced.matches) setReady(false);
        return;
      }
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const next = `${mediaPath}pacifico-${theme}.mp4`;
      if (source !== next) {
        position = media.currentTime || position;
        source = next;
        setReady(false);
        setFailed(false);
        media.src = next;
        media.load();
      }
      void media.play().catch(() => {
        /* The themed poster remains if autoplay is blocked. */
      });
    }
    const onLoaded = () => {
      media.currentTime = position % media.duration;
    };
    const onPlaying = () => setReady(true);
    const onError = () => {
      setReady(false);
      setFailed(true);
    };
    const intersection = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        syncPlayback();
      },
      { threshold: 0.05 },
    );
    const theme = new MutationObserver(() => {
      setReady(false);
      syncPlayback();
    });
    intersection.observe(container);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('loadedmetadata', onLoaded);
    media.addEventListener('playing', onPlaying);
    media.addEventListener('error', onError);
    document.addEventListener('visibilitychange', syncPlayback);
    reduced.addEventListener('change', syncPlayback);
    return () => {
      intersection.disconnect();
      theme.disconnect();
      media.pause();
      media.removeEventListener('loadedmetadata', onLoaded);
      media.removeEventListener('playing', onPlaying);
      media.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', syncPlayback);
      reduced.removeEventListener('change', syncPlayback);
    };
  }, [mediaPath]);

  return (
    <div className="video-art">
      <div className="video-frame" ref={frame} role="img" aria-label={text.label}>
        <img
          className="video-poster poster-light"
          src={`${mediaPath}pacifico-light-poster.png`}
          width="768"
          height="576"
          alt=""
          aria-hidden="true"
        />
        <img
          className="video-poster poster-dark"
          src={`${mediaPath}pacifico-dark-poster.png`}
          width="768"
          height="576"
          alt=""
          aria-hidden="true"
        />
        <video
          className={ready ? 'is-ready' : ''}
          ref={video}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
        />
      </div>
      {failed && (
        <p role="status" className="quiet-text">
          {text.error}
        </p>
      )}
    </div>
  );
}
