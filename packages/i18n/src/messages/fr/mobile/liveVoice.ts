import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/liveVoice";

export const messages = {
  "mobile.liveVoice.start": "Démarrer Live Voice",
  "mobile.liveVoice.stop": "Terminer l’appel",
  "mobile.liveVoice.mute": "Couper le micro",
  "mobile.liveVoice.unmute": "Activer le micro",
  "mobile.liveVoice.resumeAudio": "Reprendre le son",
  "mobile.liveVoice.microphoneActivity": "Niveau du microphone",
  "mobile.liveVoice.playbackActivity": "Niveau audio de l’assistant",
  "mobile.liveVoice.elapsed": "Durée de l’appel : {time}",
  "mobile.liveVoice.status.connecting": "Connexion à Live Voice…",
  "mobile.liveVoice.status.live": "Live Voice est actif",
  "mobile.liveVoice.status.stopping": "Fin de Live Voice…",
  "mobile.liveVoice.status.cleanupNeeded":
    "L’hôte a encore une session vocale active. Essayez de la terminer à nouveau.",
  "mobile.liveVoice.status.ended": "Live Voice est terminé",
  "mobile.liveVoice.error.microphone": "Le microphone est inaccessible. Vérifiez les autorisations de l’application.",
  "mobile.liveVoice.error.unavailable": "Live Voice est indisponible. Vérifiez la connexion et réessayez.",
  "mobile.liveVoice.error.stop": "Impossible de terminer Live Voice. La session hôte est peut-être encore active.",
  "mobile.liveVoice.error.send": "Impossible d’envoyer le texte à Live Voice. Votre brouillon a été restauré.",
  "mobile.liveVoice.error.textOnly":
    "Live Voice accepte uniquement du texte. Retirez les pièces jointes et le mode réponse.",
  "mobile.liveVoice.history.started": "Live Voice démarré",
  "mobile.liveVoice.history.ended": "Live Voice terminé · {time}",
} as const satisfies PartialTranslation<typeof source>;
