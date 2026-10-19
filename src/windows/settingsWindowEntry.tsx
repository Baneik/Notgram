import { SettingsWindow } from "../components/SettingsWindow";
import { mountWindow } from "./mountWindow";
import { telegramStore } from "../store/telegramStore";

const unregisterMemoryCaches = telegramStore.getState().registerMemoryCaches();
if (import.meta.hot) import.meta.hot.dispose(unregisterMemoryCaches);

mountWindow(() => <SettingsWindow />);
