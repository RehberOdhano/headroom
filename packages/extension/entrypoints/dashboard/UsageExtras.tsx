import { useEffect, useState } from 'react';
import { db } from '../../lib/db.js';
import { notesForVersion, shouldShowReleaseNotes } from '../../lib/release-notes.js';

const LAST_SEEN_KEY = 'lastSeenVersion';

/** One-time "what's new" after an update. A fresh install records the version silently (it gets
 *  onboarding, not a changelog); dismissing records it too so it never reappears. */
export function ReleaseNotesBanner() {
  const version = browser.runtime.getManifest().version;
  const [show, setShow] = useState(false);

  useEffect(() => {
    void (async () => {
      const lastSeen = (await db.meta.get(LAST_SEEN_KEY))?.value;
      if (shouldShowReleaseNotes(lastSeen, version)) setShow(true);
      else if (lastSeen === undefined) await db.meta.put({ key: LAST_SEEN_KEY, value: version });
    })();
  }, [version]);

  if (!show) return null;
  async function dismiss() {
    await db.meta.put({ key: LAST_SEEN_KEY, value: version });
    setShow(false);
  }
  return (
    <div className="notice" role="status">
      <div>
        <strong>What's new in {version}</strong>
        <ul>
          {notesForVersion(version).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
      <button type="button" className="btn" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
