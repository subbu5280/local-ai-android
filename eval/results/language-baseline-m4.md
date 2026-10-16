# Language evaluation (baseline-m4, dataset v1)

Overall: 33/42 · hard cases: 0/9

| expected language | correct |
|---|---|
| en | 7/10 |
| te | 10/10 |
| hi | 5/5 |
| ta | 4/6 |
| kn | 3/5 |
| ml | 4/6 |

## Failures

| id | input | previous | expected | got (source) |
|---|---|---|---|---|
| en-one-telugu-word | What does the word హైదరాబాద్ mean? | - | en | te (script) |
| en-one-hindi-word | Please explain what नमस्ते means and when to use it. | - | en | hi (script) |
| en-quote-tamil | My friend wrote வணக்கம் in a message, what is that greeting? | - | en | ta (script) |
| ta-roman | Kafka pathi konjam sollunga | - | ta | en (english) |
| kn-roman | Kafka bagge swalpa heli | - | kn | en (english) |
| ml-roman | Kafka ne kurichu onnu parayu | - | ml | en (english) |
| switch-ta-roman | Tamil la sollu | en | ta | en (english) |
| switch-kn-roman | kannada alli heli | en | kn | en (english) |
| switch-ml-roman | malayalam il parayu | en | ml | en (english) |