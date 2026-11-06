package run.openbot.mobile.livevoice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WakeWordPhraseMatcherTest {
  @Test
  fun acceptsJapaneseEnglishAndMildRecognitionVariantsAtUtteranceStart() {
    assertTrue(WakeWordPhraseMatcher.matches("ヘイ、オープンボット"))
    assertTrue(WakeWordPhraseMatcher.matches("はい OpenBot を起動して"))
    assertTrue(WakeWordPhraseMatcher.matches("Hey OpenBot, start a conversation"))
    assertTrue(WakeWordPhraseMatcher.matches("へーおーぷんぼっと", allowMildVariant = true))
  }

  @Test
  fun rejectsMentionsInsideOrdinarySpeechAndIncompleteOrUnrelatedPhrases() {
    assertFalse(WakeWordPhraseMatcher.matches("昨日Hey OpenBotって言った"))
    assertFalse(WakeWordPhraseMatcher.matches("OpenBotを起動して"))
    assertFalse(WakeWordPhraseMatcher.matches("へいおーぷん"))
    assertFalse(WakeWordPhraseMatcher.matches("今日は天気がいいね"))
    assertFalse(WakeWordPhraseMatcher.matches("へいおーぷんほっと"))
  }

  @Test
  fun acceptsASRApproximationOnlyWhenKeywordSpotterAlsoFoundACandidate() {
    assertTrue(WakeWordPhraseMatcher.matches("へいおーぷんほっと", allowMildVariant = true))
  }
}
