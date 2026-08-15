import { MediaViewerWindow } from "../components/MediaViewerWindow";
import { mountWindow } from "./mountWindow";
import { windowEntryId } from "./windowEntryId";

mountWindow(<MediaViewerWindow id={windowEntryId()} />);
