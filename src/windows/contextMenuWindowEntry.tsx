import { ContextMenuWindow } from "../components/ContextMenuWindow";
import { mountWindow } from "./mountWindow";
import { windowEntryId } from "./windowEntryId";

mountWindow(<ContextMenuWindow id={windowEntryId()} />);
