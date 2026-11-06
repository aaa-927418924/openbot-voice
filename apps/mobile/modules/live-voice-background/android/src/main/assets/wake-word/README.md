# On-device wake-word model

This folder contains the int8 GigaSpeech Zipformer keyword spotting model from sherpa-onnx, configured for “Hey OpenBot”. It includes standard English spellings plus phonetic spellings for the long-vowel and final-vowel pronunciation common in Japanese-accented speech. The trigger threshold is aligned with sherpa-onnx's documented 0.25 example to improve recall; this can also increase false triggers. The model and the sherpa-onnx runtime are Apache-2.0 licensed. Recognition quality and false-trigger rates still need Pixel 7a evaluation.

Upstream model: https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models
Upstream runtime: https://github.com/k2-fsa/sherpa-onnx
