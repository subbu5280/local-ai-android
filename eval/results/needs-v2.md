# Need classifier (v2, dataset v1)

Overall: 18/24

| label | correct |
|---|---|
| none | 5/9 |
| time | 3/3 |
| date | 1/2 |
| location | 4/4 |
| weather | 1/2 |
| news | 2/2 |
| price | 2/2 |

## Misses

| question | expected | got |
|---|---|---|
| Which month are we in? | date | invalid |
| Is it sunny in Pune right now? | weather | invalid |
| What is the capital of France? | none | location |
| How many minutes are in a day? | none | price |
| What time zone is India in? | none | time |
| What happened in 1947 in India? | none | news |