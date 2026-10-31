# Third-party notices

Eshlik is a fork of [Handy](https://github.com/cjpais/Handy), under the MIT
License in [LICENSE](LICENSE). It also includes the following.

## Duyu-small reference engine

`src-tauri/src/duyu/` is a Rust port of the `duyu_small/` reference engine
published with the Duyu-small model at
https://huggingface.co/KaanAydinli/Duyu-small. The original is licensed under the
Apache License, Version 2.0. The port translates it from Python to Rust and
changes it (feature extraction, decoding and model loading are reimplemented on
ONNX Runtime and ndarray). The model files themselves are not part of this
repository; Eshlik downloads them from that page at a pinned revision, under the
same license.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use these files except in compliance with the License.
    You may obtain a copy of the License at

        https://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

## Fonts

Outfit, Karla and JetBrains Mono come from the `@fontsource-variable` npm
packages and are licensed under the SIL Open Font License 1.1.
