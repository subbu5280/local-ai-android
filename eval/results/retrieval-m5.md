# Retrieval evaluation (m5, dataset v1)

## keyword

Answerable queries 28: hit@1 0.714, hit@3 0.714, MRR 0.714, no evidence reported 0.357. No-evidence queries 7: evidence wrongly reported 0. Duplicate pair in top 3: 0. Mean laptop latency 0 ms/query.

| kind | queries | hit@1 | hit@3 | MRR | false evidence |
|---|---|---|---|---|---|
| exact | 7 | 1 | 1 | 1 | - |
| inflected | 5 | 1 | 1 | 1 | - |
| paraphrase | 3 | 1 | 1 | 1 | - |
| synonym | 3 | 0.333 | 0.333 | 0.333 | - |
| cross_language | 6 | 0 | 0 | 0 | - |
| mixed | 3 | 1 | 1 | 1 | - |
| no_evidence | 7 | - | - | - | 0 |
| duplicate | 1 | 1 | 1 | 1 | - |

<details><summary>Per query</summary>

| query | kind | relevant | top 3 documents | evidence |
|---|---|---|---|---|
| en-exact-refund | exact | refund-en, refund-copy-en | refund-en | yes |
| en-exact-kafka | exact | kafka-en | kafka-en, kafka-mixed-te | yes |
| hi-exact | exact | train-hi | train-hi | yes |
| te-exact | exact | rice-te | rice-te | yes |
| ta-exact | exact | diabetes-ta | diabetes-ta | yes |
| kn-exact | exact | library-kn | library-kn | yes |
| ml-exact | exact | coconut-ml | coconut-ml | yes |
| te-inflected | inflected | rice-te | rice-te | yes |
| ta-inflected | inflected | diabetes-ta | diabetes-ta | yes |
| kn-inflected | inflected | library-kn | library-kn | yes |
| ml-inflected | inflected | coconut-ml | coconut-ml | yes |
| hi-inflected | inflected | train-hi | train-hi | yes |
| en-para-money | paraphrase | refund-en, refund-copy-en | refund-en | no |
| en-para-card | paraphrase | refund-en, refund-copy-en | refund-en | yes |
| hi-para | paraphrase | train-hi | train-hi | yes |
| en-syn-reimburse | synonym | refund-en, refund-copy-en | (none) | no |
| en-syn-readers | synonym | kafka-en | (none) | no |
| en-syn-modem | synonym | wifi-en | wifi-en | no |
| xl-en-kn | cross_language | library-kn | (none) | no |
| xl-en-te | cross_language | rice-te | (none) | no |
| xl-te-en | cross_language | refund-en, refund-copy-en | (none) | no |
| xl-hi-ta | cross_language | diabetes-ta | (none) | no |
| xl-ta-ml | cross_language | coconut-ml | diabetes-ta | no |
| xl-ml-hi | cross_language | train-hi | (none) | no |
| mix-te | mixed | kafka-en, kafka-mixed-te | kafka-mixed-te, kafka-en | yes |
| mix-hi | mixed | refund-en, refund-copy-en, train-hi | refund-en | yes |
| mix-ml | mixed | kafka-en | kafka-en, kafka-mixed-te | yes |
| ne-en | no_evidence | (none) | (none) | no |
| ne-en-shared-word | no_evidence | (none) | wifi-en, refund-en | no |
| ne-te | no_evidence | (none) | (none) | no |
| ne-hi | no_evidence | (none) | (none) | no |
| ne-ta | no_evidence | (none) | (none) | no |
| ne-kn | no_evidence | (none) | (none) | no |
| ne-ml | no_evidence | (none) | (none) | no |
| dup-refund | duplicate | refund-en, refund-copy-en | refund-en | yes |

</details>
