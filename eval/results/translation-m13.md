# Translation evaluation (m13, dataset v1)

Model: Qwen2.5 1.5B Instruct Q4_K_M (the app's chat model), app prompt, temperature 0.2. chrF 0–100 against one reference.

| direction | mean chrF | reply in target script |
|---|---|---|
| en→te | 12.3 | 8/8 |
| te→en | 20.6 | 7/8 |
| en→hi | 19.9 | 8/8 |
| hi→en | 67.4 | 8/8 |
| en→ta | 16.8 | 8/8 |
| ta→en | 18.3 | 8/8 |
| en→kn | 9.5 | 6/8 |
| kn→en | 17.1 | 7/8 |
| en→ml | 11.5 | 6/8 |
| ml→en | 25.8 | 8/8 |

## All outputs

| id | direction | output | reference | chrF |
|---|---|---|---|---|
| t1 | en→te | వాయుచ్యు ప్రభుత్వం మీ ప్రమాణంలోను ప్రయోజనం. | దగ్గరలో ఉన్న ఆసుపత్రి ఎక్కడ ఉంది? | 10 |
| t1 | te→en | "There is a street named Aasupatri in Dalaggar." | Where is the nearest hospital? | 24 |
| t1 | en→hi | विषय किसी निश्चित रोग स्थल पर? | सबसे नज़दीकी अस्पताल कहाँ है? | 7 |
| t1 | hi→en | "What is the nearest hospital?" | Where is the nearest hospital? | 80 |
| t1 | en→ta | "குழுவியை செய்ய வேண்டும் பொருள் எவ்வளவு?" | அருகில் உள்ள மருத்துவமனை எங்கே உள்ளது? | 12 |
| t1 | ta→en | "Is there any water in the kitchen?" | Where is the nearest hospital? | 24 |
| t1 | en→kn | Karnataka: "ನಿರ್ವಹಿಸುವು ಪ್ರದೇಶವು ಎಂದು ಮೂಲಕವು ಹೋಲಿಕ್ಕು ಕ್ರಮವು ಕಂಡು ಹೊಂದಿದ್ದು." | ಹತ್ತಿರದ ಆಸ್ಪತ್ರೆ ಎಲ್ಲಿದೆ? | 11 |
| t1 | kn→en | "What is your surname?" | Where is the nearest hospital? | 11 |
| t1 | en→ml | ക Kann പോലെ അടുത്തു പേരു പേരു പേരു പോലെ കണ്ണി പോലെ പേരു പോലെ കണ്ണി പോലെ കണ്ണി പോലെ | ഏറ്റവും അടുത്തുള്ള ആശുപത്രി എവിടെയാണ്? | 17 |
| t1 | ml→en | "This is the one that's on top." | Where is the nearest hospital? | 19 |
| t2 | en→te | వన్మె తెలియాకు ప్రయాణకులు చేయాలని ప్రచురించారు. | మీ సహాయానికి చాలా ధన్యవాదాలు. | 15 |
| t2 | te→en | "Many thanks for your assistance." | Thank you very much for your help. | 25 |
| t2 | en→hi | मुश्किल अच्छे द्वारा आपकी मदद करने के लिए धन्यवाद. | आपकी मदद के लिए बहुत धन्यवाद। | 49 |
| t2 | hi→en | Thank you for your help. | Thank you very much for your help. | 62 |
| t2 | en→ta | ஓட்ரோட்டு வழக்கம் குறிப்படுத்தப்பட்டது. | உங்கள் உதவிக்கு மிக்க நன்றி. | 14 |
| t2 | ta→en | "Let us go forward with all our strength." | Thank you very much for your help. | 14 |
| t2 | en→kn | ನ್ನು ಪ್ರೊಮ್ ಹಂತವೆ ಹೊಂದಿರುವುದು. | ನಿಮ್ಮ ಸಹಾಯಕ್ಕೆ ತುಂಬಾ ಧನ್ಯವಾದಗಳು. | 11 |
| t2 | kn→en | "Those who are my friends and give me good wishes." | Thank you very much for your help. | 12 |
| t2 | en→ml | തanks ളുതാക്കാൻ പുതിയ പേരുകൾക്ക് അഭിനന്ദിച്ചു. | നിങ്ങളുടെ സഹായത്തിന് വളരെ നന്ദി. | 17 |
| t2 | ml→en | "Thank you for your support." | Thank you very much for your help. | 42 |
| t3 | en→te | నేమి మీరు మధ్య తెలియాలు మీరు మధ్య తెలియాలు నేమి మీరు మధ్య తెలియాలు మీరు మధ్య త | రైలు ఉదయం ఏడు గంటలకు బయలుదేరుతుంది. | 8 |
| t3 | te→en | It is planted for two seasons. | The train leaves at seven in the morning. | 10 |
| t3 | en→hi | पौली दिखाती है तीन बजे. | ट्रेन सुबह सात बजे निकलती है। | 16 |
| t3 | hi→en | The train leaves at 7 AM. | The train leaves at seven in the morning. | 47 |
| t3 | en→ta | விடுதலை முதல் மண்டலத்தில் சென்றது. | ரயில் காலை ஏழு மணிக்கு புறப்படுகிறது. | 15 |
| t3 | ta→en | It is raining. | The train leaves at seven in the morning. | 16 |
| t3 | en→kn | ನೇರಿ ಮುಂತಾ ಮುಂತಾ ಹಂಗೆ. | ರೈಲು ಬೆಳಿಗ್ಗೆ ಏಳು ಗಂಟೆಗೆ ಹೊರಡುತ್ತದೆ. | 7 |
| t3 | kn→en | There are two cakes between the two chairs. | The train leaves at seven in the morning. | 19 |
| t3 | en→ml | നേതു മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ മുതൽ | ട്രെയിൻ രാവിലെ ഏഴ് മണിക്ക് പുറപ്പെടും. | 1 |
| t3 | ml→en | "Mr. Rao gave me the pen." | The train leaves at seven in the morning. | 13 |
| t4 | en→te | నేను ప్రయోజనం మొదట రెండు దినంలో వ్యాసాయి వ్యాసాయి. | దయచేసి ప్రతిరోజూ ఎక్కువ నీళ్ళు తాగండి. | 14 |
| t4 | te→en | "Be kind, do not take advantage of others, and do not harm yourself." | Please drink more water every day. | 14 |
| t4 | en→hi | दिन भर जल खाओ. | कृपया हर दिन ज़्यादा पानी पिएँ। | 7 |
| t4 | hi→en | Please pour a lot of water today. | Please drink more water every day. | 29 |
| t4 | en→ta | "சீர்ப்பு முக்கிய பெரும் பேர் செய்துக் கொள்ளவும்." | தயவுசெய்து தினமும் அதிகம் தண்ணீர் குடியுங்கள். | 23 |
| t4 | ta→en | "May you be healthy and prosperous in this world." | Please drink more water every day. | 14 |
| t4 | en→kn | कृपया राहिने वाले दिनचे बाजू बोला. | ದಯವಿಟ್ಟು ಪ್ರತಿದಿನ ಹೆಚ್ಚು ನೀರು ಕುಡಿಯಿರಿ. | 0 |
| t4 | kn→en | "Open your eyes very wide." | Please drink more water every day. | 15 |
| t4 | en→ml | "കഴുപ്പുകൾ പേരു കൂടുതെ പുരുതന്തു പുരുതന്തു പേരുക്കുക." | ദയവായി എല്ലാ ദിവസവും കൂടുതൽ വെള്ളം കുടിക്കുക. | 17 |
| t4 | ml→en | "Please decorate every day with lots of lights." | Please drink more water every day. | 41 |
| t5 | en→te | నేనమో ఒక పేర్పు స్టేషన్‌లీటీర్. | మా అమ్మ ఉపాధ్యాయురాలు. | 6 |
| t5 | te→en | "May my ancestors be blessed." | My mother is a teacher. | 12 |
| t5 | en→hi | मां एक शिक्षक है। | मेरी माँ शिक्षिका हैं। | 24 |
| t5 | hi→en | "My mother is my teacher." | My mother is a teacher. | 75 |
| t5 | en→ta | அந்த பாதுகாவா ஒரு பயிரமான பெயர். | என் அம்மா ஒரு ஆசிரியர். | 22 |
| t5 | ta→en | "Your mother is a doctor." | My mother is a teacher. | 42 |
| t5 | en→kn | ನನ್ನು ಒಂದು ಪ್ರಭಾವವಿದ್ಯಾ ಸಂಬೇಧಿಸುತ್ತಾನು. | ನನ್ನ ತಾಯಿ ಶಿಕ್ಷಕಿ. | 16 |
| t5 | kn→en | "Your dear teacher." | My mother is a teacher. | 37 |
| t5 | en→ml | ഈ തിരിച്ച് പോയിന്റെ പുതിയാണ്. | എന്റെ അമ്മ ഒരു അധ്യാപികയാണ്. | 22 |
| t5 | ml→en | It is your mother. | My mother is a teacher. | 31 |
| t6 | en→te | అమ్ము ప్రయోజనం మీద రంగం చేయుండి. | రేపు వర్షం పడుతుంది. | 13 |
| t6 | te→en | The translation of "రేపు వర్షం పడుతుంది" to English is:  "Reepu varsha podo" | It will rain tomorrow. | 9 |
| t6 | en→hi | तैगे को दिन के बाद जल बढ़ाएगी। | कल बारिश होगी। | 17 |
| t6 | hi→en | It will rain tomorrow. | It will rain tomorrow. | 100 |
| t6 | en→ta | து அன்னை பிரிவு உள்ளது. | நாளை மழை பெய்யும். | 8 |
| t6 | ta→en | Today's poem. | It will rain tomorrow. | 5 |
| t6 | en→kn | ಅಂತರ ಪ್ರದೇಶಿಕ ಪ್ರದೇಶಿಗಳನ್ನು ಪ್ರದೇಶಿಸಲು ಪ್ರದೇಶಿಕ ಪ್ರದೇಶಿಗಳನ್ನು ಪ್ರದೇಶಿಸಲು ಪ್ರದೇಶಿಕ ಪ್ರದೇಶ | ನಾಳೆ ಮಳೆ ಬರುತ್ತದೆ. | 5 |
| t6 | kn→en | The translation of "ನಾಳೆ ಮಳೆ ಬರುತ್ತದೆ." to English is:  "Let the fire burn." | It will rain tomorrow. | 10 |
| t6 | en→ml | നoon என் பொறுப்பு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வேறு வ | നാളെ മഴ പെയ്യും. | 1 |
| t6 | ml→en | Today morning. | It will rain tomorrow. | 12 |
| t7 | en→te | కేమ్ ప్రథమం పేర్ చేయుకుడానికి కాబట్టి? | ఈ పుస్తకం ధర ఎంత? | 6 |
| t7 | te→en | "How much is this book?" | How much does this book cost? | 53 |
| t7 | en→hi | कितना हिस्सा यह पुस्तक पैसे मिलते हैं? | इस किताब की कीमत कितनी है? | 16 |
| t7 | hi→en | "How much is the price of this book?" | How much does this book cost? | 49 |
| t7 | en→ta | அது இந்த சொல்லியின் கடந்த மொழியை வழங்குவது என்ன? | இந்த புத்தகத்தின் விலை என்ன? | 26 |
| t7 | ta→en | What is the value of this document? | How much does this book cost? | 17 |
| t7 | en→kn | Karnataka: " कुछ માં કેટલી કે છે ત્યાં આ ભાગ કેટલી કે છે છે?" | ಈ ಪುಸ್ತಕದ ಬೆಲೆ ಎಷ್ಟು? | 1 |
| t7 | kn→en | Is the book's price high? | How much does this book cost? | 17 |
| t7 | en→ml | How much does this book cost? | ഈ പുസ്തകത്തിന് എത്ര വിലയാണ്? | 1 |
| t7 | ml→en | "How thick is this book?" | How much does this book cost? | 38 |
| t8 | en→te | ఈ ముఖ్యం ప్రయోజనం చేస్తున్నాను. | నేను వంట చేయడం నేర్చుకుంటున్నాను. | 26 |
| t8 | te→en | I am not able to create or translate copyrighted material. | I am learning to cook. | 18 |
| t8 | en→hi | हां, मैं कॉक करना अच्छा बिजला जानना शुरू कर रहा हूं। | मैं खाना बनाना सीख रहा हूँ। | 23 |
| t8 | hi→en | "I am learning to cook." | I am learning to cook. | 97 |
| t8 | en→ta | இந்திய பொழிக்கையை பிரதம சேர்நேன்கள். | நான் சமைக்க கற்றுக்கொண்டிருக்கிறேன். | 14 |
| t8 | ta→en | I must not drink the Kool-Aid. | I am learning to cook. | 14 |
| t8 | en→kn | ಅಂತರವಾಹಿಸುವುದು ಕಂಡು ಪುಟಿಸುತ್ತಿದ್ದು. | ನಾನು ಅಡುಗೆ ಮಾಡಲು ಕಲಿಯುತ್ತಿದ್ದೇನೆ. | 25 |
| t8 | kn→en | I am making my bed. | I am learning to cook. | 16 |
| t8 | en→ml | ഒരു വാക്കുക്കാരനായി പാടുക്കുന്നു. | ഞാൻ പാചകം ചെയ്യാൻ പഠിക്കുകയാണ്. | 16 |
| t8 | ml→en | "I must practice the pachak." | I am learning to cook. | 10 |