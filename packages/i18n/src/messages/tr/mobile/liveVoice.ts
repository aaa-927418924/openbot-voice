import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/liveVoice";

export const messages = {
  "mobile.liveVoice.start": "Live Voice'u başlat",
  "mobile.liveVoice.stop": "Aramayı bitir",
  "mobile.liveVoice.mute": "Mikrofonu kapat",
  "mobile.liveVoice.unmute": "Mikrofonu aç",
  "mobile.liveVoice.resumeAudio": "Sesi sürdür",
  "mobile.liveVoice.microphoneActivity": "Mikrofon ses seviyesi",
  "mobile.liveVoice.playbackActivity": "Asistan ses seviyesi",
  "mobile.liveVoice.elapsed": "Arama süresi {time}",
  "mobile.liveVoice.status.connecting": "Live Voice'a bağlanıyor…",
  "mobile.liveVoice.status.live": "Live Voice etkin",
  "mobile.liveVoice.status.stopping": "Live Voice bitiriliyor…",
  "mobile.liveVoice.status.cleanupNeeded": "Sunucuda hâlâ etkin bir ses oturumu var. Yeniden bitirmeyi deneyin.",
  "mobile.liveVoice.status.ended": "Live Voice sona erdi",
  "mobile.liveVoice.error.microphone": "Mikrofona erişilemiyor. Uygulama izinlerini kontrol edin.",
  "mobile.liveVoice.error.unavailable": "Live Voice kullanılamıyor. Bağlantıyı kontrol edip yeniden deneyin.",
  "mobile.liveVoice.error.stop": "Live Voice bitirilemedi. Sunucu oturumu hâlâ etkin olabilir.",
  "mobile.liveVoice.error.send": "Live Voice'a metin gönderilemedi. Taslağınız geri yüklendi.",
  "mobile.liveVoice.error.textOnly":
    "Live Voice yalnızca metin kabul eder. Göndermek için ekleri ve yanıt modunu kaldırın.",
  "mobile.liveVoice.history.started": "Live Voice başladı",
  "mobile.liveVoice.history.ended": "Live Voice sona erdi · {time}",
} as const satisfies PartialTranslation<typeof source>;
