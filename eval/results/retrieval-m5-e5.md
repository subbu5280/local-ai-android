# Retrieval evaluation (m5-e5, dataset v1)

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

## semantic only

Answerable queries 28: hit@1 0.893, hit@3 1, MRR 0.94, no evidence reported 0. No-evidence queries 7: evidence wrongly reported 0. Duplicate pair in top 3: 0. Mean laptop latency 10 ms/query.

| kind | queries | hit@1 | hit@3 | MRR | false evidence |
|---|---|---|---|---|---|
| exact | 7 | 1 | 1 | 1 | - |
| inflected | 5 | 1 | 1 | 1 | - |
| paraphrase | 3 | 1 | 1 | 1 | - |
| synonym | 3 | 1 | 1 | 1 | - |
| cross_language | 6 | 0.667 | 1 | 0.806 | - |
| mixed | 3 | 0.667 | 1 | 0.833 | - |
| no_evidence | 7 | - | - | - | 0 |
| duplicate | 1 | 1 | 1 | 1 | - |

<details><summary>Per query</summary>

| query | kind | relevant | top 3 documents | evidence |
|---|---|---|---|---|
| en-exact-refund | exact | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |
| en-exact-kafka | exact | kafka-en | kafka-en, kafka-mixed-te, refund-en | yes |
| hi-exact | exact | train-hi | train-hi, refund-copy-en, library-kn | yes |
| te-exact | exact | rice-te | rice-te, coconut-ml, library-kn | yes |
| ta-exact | exact | diabetes-ta | diabetes-ta, coconut-ml, library-kn | yes |
| kn-exact | exact | library-kn | library-kn, train-hi, kafka-mixed-te | yes |
| ml-exact | exact | coconut-ml | coconut-ml, rice-te, diabetes-ta | yes |
| te-inflected | inflected | rice-te | rice-te, coconut-ml, diabetes-ta | yes |
| ta-inflected | inflected | diabetes-ta | diabetes-ta, coconut-ml, rice-te | yes |
| kn-inflected | inflected | library-kn | library-kn, train-hi, coconut-ml | yes |
| ml-inflected | inflected | coconut-ml | coconut-ml, rice-te, diabetes-ta | yes |
| hi-inflected | inflected | train-hi | train-hi, refund-copy-en, library-kn | yes |
| en-para-money | paraphrase | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |
| en-para-card | paraphrase | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |
| hi-para | paraphrase | train-hi | train-hi, refund-copy-en, library-kn | yes |
| en-syn-reimburse | synonym | refund-en, refund-copy-en | refund-copy-en, library-kn, train-hi | yes |
| en-syn-readers | synonym | kafka-en | kafka-en, kafka-mixed-te, library-kn | yes |
| en-syn-modem | synonym | wifi-en | wifi-en, refund-en, kafka-en | yes |
| xl-en-kn | cross_language | library-kn | library-kn, refund-copy-en, train-hi | yes |
| xl-en-te | cross_language | rice-te | coconut-ml, rice-te, refund-copy-en | yes |
| xl-te-en | cross_language | refund-en, refund-copy-en | train-hi, library-kn, refund-copy-en | yes |
| xl-hi-ta | cross_language | diabetes-ta | diabetes-ta, coconut-ml, library-kn | yes |
| xl-ta-ml | cross_language | coconut-ml | coconut-ml, rice-te, diabetes-ta | yes |
| xl-ml-hi | cross_language | train-hi | train-hi, refund-copy-en, library-kn | yes |
| mix-te | mixed | kafka-en, kafka-mixed-te | kafka-mixed-te, kafka-en, library-kn | yes |
| mix-hi | mixed | refund-en, refund-copy-en, train-hi | refund-en, train-hi, library-kn | yes |
| mix-ml | mixed | kafka-en | kafka-mixed-te, kafka-en, library-kn | yes |
| ne-en | no_evidence | (none) | kafka-en, wifi-en, diabetes-ta | no |
| ne-en-shared-word | no_evidence | (none) | library-kn, refund-en, kafka-en | no |
| ne-te | no_evidence | (none) | train-hi, library-kn, rice-te | no |
| ne-hi | no_evidence | (none) | library-kn, coconut-ml, rice-te | no |
| ne-ta | no_evidence | (none) | diabetes-ta, library-kn, coconut-ml | no |
| ne-kn | no_evidence | (none) | library-kn, coconut-ml, train-hi | no |
| ne-ml | no_evidence | (none) | coconut-ml, library-kn, diabetes-ta | no |
| dup-refund | duplicate | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |

</details>

## hybrid

Answerable queries 28: hit@1 0.893, hit@3 1, MRR 0.94, no evidence reported 0. No-evidence queries 7: evidence wrongly reported 0. Duplicate pair in top 3: 0. Mean laptop latency 5 ms/query.

| kind | queries | hit@1 | hit@3 | MRR | false evidence |
|---|---|---|---|---|---|
| exact | 7 | 1 | 1 | 1 | - |
| inflected | 5 | 1 | 1 | 1 | - |
| paraphrase | 3 | 1 | 1 | 1 | - |
| synonym | 3 | 1 | 1 | 1 | - |
| cross_language | 6 | 0.5 | 1 | 0.722 | - |
| mixed | 3 | 1 | 1 | 1 | - |
| no_evidence | 7 | - | - | - | 0 |
| duplicate | 1 | 1 | 1 | 1 | - |

<details><summary>Per query</summary>

| query | kind | relevant | top 3 documents | evidence |
|---|---|---|---|---|
| en-exact-refund | exact | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |
| en-exact-kafka | exact | kafka-en | kafka-en, kafka-mixed-te, refund-en | yes |
| hi-exact | exact | train-hi | train-hi, refund-copy-en, library-kn | yes |
| te-exact | exact | rice-te | rice-te, coconut-ml, library-kn | yes |
| ta-exact | exact | diabetes-ta | diabetes-ta, coconut-ml, library-kn | yes |
| kn-exact | exact | library-kn | library-kn, train-hi, kafka-mixed-te | yes |
| ml-exact | exact | coconut-ml | coconut-ml, rice-te, diabetes-ta | yes |
| te-inflected | inflected | rice-te | rice-te, coconut-ml, diabetes-ta | yes |
| ta-inflected | inflected | diabetes-ta | diabetes-ta, coconut-ml, rice-te | yes |
| kn-inflected | inflected | library-kn | library-kn, train-hi, coconut-ml | yes |
| ml-inflected | inflected | coconut-ml | coconut-ml, rice-te, diabetes-ta | yes |
| hi-inflected | inflected | train-hi | train-hi, refund-copy-en, library-kn | yes |
| en-para-money | paraphrase | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |
| en-para-card | paraphrase | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |
| hi-para | paraphrase | train-hi | train-hi, refund-copy-en, library-kn | yes |
| en-syn-reimburse | synonym | refund-en, refund-copy-en | refund-copy-en, library-kn, train-hi | yes |
| en-syn-readers | synonym | kafka-en | kafka-en, kafka-mixed-te, library-kn | yes |
| en-syn-modem | synonym | wifi-en | wifi-en, refund-en, kafka-en | yes |
| xl-en-kn | cross_language | library-kn | library-kn, refund-copy-en, train-hi | yes |
| xl-en-te | cross_language | rice-te | coconut-ml, rice-te, refund-copy-en | yes |
| xl-te-en | cross_language | refund-en, refund-copy-en | train-hi, library-kn, refund-copy-en | yes |
| xl-hi-ta | cross_language | diabetes-ta | diabetes-ta, coconut-ml, library-kn | yes |
| xl-ta-ml | cross_language | coconut-ml | diabetes-ta, coconut-ml, rice-te | yes |
| xl-ml-hi | cross_language | train-hi | train-hi, refund-copy-en, library-kn | yes |
| mix-te | mixed | kafka-en, kafka-mixed-te | kafka-mixed-te, kafka-en, library-kn | yes |
| mix-hi | mixed | refund-en, refund-copy-en, train-hi | refund-en, train-hi, library-kn | yes |
| mix-ml | mixed | kafka-en | kafka-en, kafka-mixed-te, library-kn | yes |
| ne-en | no_evidence | (none) | kafka-en, wifi-en, diabetes-ta | no |
| ne-en-shared-word | no_evidence | (none) | refund-en, wifi-en, library-kn | no |
| ne-te | no_evidence | (none) | train-hi, library-kn, rice-te | no |
| ne-hi | no_evidence | (none) | library-kn, coconut-ml, rice-te | no |
| ne-ta | no_evidence | (none) | diabetes-ta, library-kn, coconut-ml | no |
| ne-kn | no_evidence | (none) | library-kn, coconut-ml, train-hi | no |
| ne-ml | no_evidence | (none) | coconut-ml, library-kn, diabetes-ta | no |
| dup-refund | duplicate | refund-en, refund-copy-en | refund-en, train-hi, library-kn | yes |

</details>

## Embedding details

Model multilingual-e5-small-q8_0 via http://127.0.0.1:8091. Indexed 10 passages in 109 ms on the laptop (not a phone measurement).
Best cosine per query: answerable min 0.781 / median 0.87; no-evidence max 0.747 / median 0.738. Evidence threshold in use: 0.77.

| query | kind | answerable | best cosine |
|---|---|---|---|
| en-exact-refund | exact | yes | 0.895 |
| en-exact-kafka | exact | yes | 0.863 |
| hi-exact | exact | yes | 0.922 |
| te-exact | exact | yes | 0.9 |
| ta-exact | exact | yes | 0.889 |
| kn-exact | exact | yes | 0.874 |
| ml-exact | exact | yes | 0.909 |
| te-inflected | inflected | yes | 0.858 |
| ta-inflected | inflected | yes | 0.872 |
| kn-inflected | inflected | yes | 0.864 |
| ml-inflected | inflected | yes | 0.872 |
| hi-inflected | inflected | yes | 0.893 |
| en-para-money | paraphrase | yes | 0.861 |
| en-para-card | paraphrase | yes | 0.892 |
| hi-para | paraphrase | yes | 0.907 |
| en-syn-reimburse | synonym | yes | 0.781 |
| en-syn-readers | synonym | yes | 0.809 |
| en-syn-modem | synonym | yes | 0.853 |
| xl-en-kn | cross_language | yes | 0.797 |
| xl-en-te | cross_language | yes | 0.791 |
| xl-te-en | cross_language | yes | 0.833 |
| xl-hi-ta | cross_language | yes | 0.802 |
| xl-ta-ml | cross_language | yes | 0.802 |
| xl-ml-hi | cross_language | yes | 0.882 |
| mix-te | mixed | yes | 0.87 |
| mix-hi | mixed | yes | 0.853 |
| mix-ml | mixed | yes | 0.851 |
| ne-en | no_evidence | no | 0.738 |
| ne-en-shared-word | no_evidence | no | 0.728 |
| ne-te | no_evidence | no | 0.742 |
| ne-hi | no_evidence | no | 0.738 |
| ne-ta | no_evidence | no | 0.747 |
| ne-kn | no_evidence | no | 0.74 |
| ne-ml | no_evidence | no | 0.716 |
| dup-refund | duplicate | yes | 0.893 |
