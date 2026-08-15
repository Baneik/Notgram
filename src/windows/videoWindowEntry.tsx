import { VideoWindow } from "../components/VideoWindow";
import { mountWindow } from "./mountWindow";
import { windowEntryId } from "./windowEntryId";

mountWindow(<VideoWindow id={windowEntryId()} />);
