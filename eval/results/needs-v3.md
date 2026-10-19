# Need classifier (v3, dataset v1)

Overall: 13/24

| label | correct |
|---|---|
| none | 6/9 |
| time | 3/3 |
| date | 0/2 |
| location | 0/4 |
| weather | 2/2 |
| news | 0/2 |
| price | 2/2 |

## Misses

| question | expected | got |
|---|---|---|
| Which area am I currently standing in? | location | time |
| Can you figure out what city this is? | location | none |
| What neighbourhood is this? | location | none |
| Tell me my present location please | location | none |
| What's today? | date | time |
| Which month are we in? | date | time |
| Any big events happening in India today? | news | time |
| Who won yesterday's cricket match? | news | time |
| How do I reverse a list in Python? | none | news |
| Why is the sky blue? | none | weather |
| Can you suggest a name for my dog? | none | time |