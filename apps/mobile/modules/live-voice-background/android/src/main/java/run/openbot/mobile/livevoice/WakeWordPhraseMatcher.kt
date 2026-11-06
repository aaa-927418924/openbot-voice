package run.openbot.mobile.livevoice

import java.text.Normalizer
import java.util.Locale

/** Matches only the beginning of local ASR output. The transcript is never returned or logged. */
internal object WakeWordPhraseMatcher {
  private val phrases = listOf(
    "へいおーぷんぼっと",
    "はいおーぷんぼっと",
    "えいおーぷんぼっと",
    "へいopenbot",
    "はいopenbot",
    "えいopenbot",
    "heyおーぷんぼっと",
    "heiおーぷんぼっと",
    "heyopenbot",
    "heiopenbot",
  )

  fun matches(transcript: String, allowMildVariant: Boolean = false): Boolean {
    val normalized = normalize(transcript)
    if (normalized.isEmpty()) return false
    val maximumEditDistance = if (allowMildVariant) MAX_EDIT_DISTANCE else 0

    return phrases.any { phrase ->
      val minimumLength = (phrase.length - maximumEditDistance).coerceAtLeast(1)
      val maximumLength = minOf(phrase.length + maximumEditDistance, normalized.length)
      for (length in minimumLength..maximumLength) {
        if (levenshteinWithin(normalized.substring(0, length), phrase, maximumEditDistance)) return@any true
      }
      false
    }
  }

  private fun normalize(value: String): String {
    val normalized = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
    return buildString(normalized.length) {
      for (character in normalized) {
        when {
          character in '\u30a1'..'\u30f6' -> append(character - 0x60)
          character.isLetterOrDigit() || character == '\u30fc' -> append(character)
        }
      }
    }
  }

  private fun levenshteinWithin(left: String, right: String, maximum: Int): Boolean {
    if (kotlin.math.abs(left.length - right.length) > maximum) return false
    var previous = IntArray(right.length + 1) { it }
    var current = IntArray(right.length + 1)

    for (leftIndex in left.indices) {
      current[0] = leftIndex + 1
      var rowMinimum = current[0]
      for (rightIndex in right.indices) {
        val substitution = previous[rightIndex] + if (left[leftIndex] == right[rightIndex]) 0 else 1
        current[rightIndex + 1] = minOf(
          previous[rightIndex + 1] + 1,
          current[rightIndex] + 1,
          substitution,
        )
        rowMinimum = minOf(rowMinimum, current[rightIndex + 1])
      }
      if (rowMinimum > maximum) return false
      val temporary = previous
      previous = current
      current = temporary
    }
    return previous[right.length] <= maximum
  }

  // One recognition error is enough to tolerate a mild accent or ASR typo. Matching is anchored
  // to the start of the utterance so ordinary speech that mentions a similar phrase later cannot
  // start a call.
  private const val MAX_EDIT_DISTANCE = 1
}
