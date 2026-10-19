# Need detection by nearest examples (knn1)

Overall: 17/24

| label | correct |
|---|---|
| none | 5/9 |
| time | 3/3 |
| date | 2/2 |
| location | 3/4 |
| weather | 2/2 |
| news | 0/2 |
| price | 2/2 |

## Misses

| question | expected | got |
|---|---|---|
| Tell me my present location please | location | time |
| Any big events happening in India today? | news | date |
| Who won yesterday's cricket match? | news | date |
| What is Kafka used for? | none | time |
| What is the capital of France? | none | location |
| How many minutes are in a day? | none | time |
| What time zone is India in? | none | time |