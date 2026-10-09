import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/liveVoice";

export const messages = {
  "mobile.liveVoice.start": "Iniciar Live Voice",
  "mobile.liveVoice.stop": "Encerrar chamada",
  "mobile.liveVoice.mute": "Silenciar microfone",
  "mobile.liveVoice.unmute": "Ativar microfone",
  "mobile.liveVoice.resumeAudio": "Retomar áudio",
  "mobile.liveVoice.microphoneActivity": "Nível do microfone",
  "mobile.liveVoice.playbackActivity": "Nível de áudio do assistente",
  "mobile.liveVoice.elapsed": "Duração da chamada {time}",
  "mobile.liveVoice.status.connecting": "Conectando ao Live Voice…",
  "mobile.liveVoice.status.live": "Live Voice ativo",
  "mobile.liveVoice.status.stopping": "Encerrando Live Voice…",
  "mobile.liveVoice.status.cleanupNeeded": "O host ainda tem uma sessão de voz ativa. Tente encerrá-la novamente.",
  "mobile.liveVoice.status.ended": "Live Voice encerrado",
  "mobile.liveVoice.error.microphone": "O microfone está indisponível. Confira as permissões do app.",
  "mobile.liveVoice.error.unavailable": "Live Voice está indisponível. Confira a conexão e tente novamente.",
  "mobile.liveVoice.error.stop": "Não foi possível encerrar o Live Voice. A sessão no host pode continuar ativa.",
  "mobile.liveVoice.error.send": "Não foi possível enviar o texto ao Live Voice. Seu rascunho foi restaurado.",
  "mobile.liveVoice.error.textOnly":
    "O Live Voice aceita apenas texto. Remova anexos e o modo de resposta para enviar.",
  "mobile.liveVoice.history.started": "Live Voice iniciado",
  "mobile.liveVoice.history.ended": "Live Voice encerrado · {time}",
} as const satisfies PartialTranslation<typeof source>;
