import { GlassSurface } from './LiquidGlass';

/** First screen: VideoGit on the converging beam, then a glass Continue. */
export function Intro({ leaving, onContinue }: { leaving: boolean; onContinue(): void }) {
  return <section
    aria-labelledby="videogit-wordmark"
    className="vg-intro"
    data-leaving={leaving ? 'true' : 'false'}
  >
    <h1 className="vg-intro-title" id="videogit-wordmark">VideoGit</h1>
    <button className="vg-glass vg-continue" onClick={onContinue} type="button">
      <GlassSurface />
      <span className="vg-glass-body">Continue</span>
    </button>
  </section>;
}
