// On-device image generation (stable-diffusion.cpp, pinned commit 95b3090) for AiImageModule.kt.
// One context at a time: load the model, generate one image, write it as PNG, free everything. The model is only in
// memory while an image is being made, so it never sits next to the chat model in RAM.
#include <jni.h>
#include <atomic>
#include <string>
#include "stable-diffusion.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
#include "stb_image_write.h"

static std::atomic<sd_ctx_t*> g_ctx{nullptr};
static std::atomic<int> g_step{0};

static void on_progress(int step, int steps, float, void*) { g_step = step; }

static std::string str(JNIEnv* env, jstring s) {
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out(c);
  env->ReleaseStringUTFChars(s, c);
  return out;
}

// Returns "" on success, or an error message.
extern "C" JNIEXPORT jstring JNICALL
Java_com_subbu_localai_AiImageModule_nativeGenerate(JNIEnv* env, jclass, jstring jModel, jstring jTaesd, jstring jPrompt, jint width,
                                                   jint height, jint steps, jlong seed, jint threads, jstring jOut) {
  std::string model = str(env, jModel), taesd = str(env, jTaesd), prompt = str(env, jPrompt), out = str(env, jOut);
  g_step = 0;
  sd_set_progress_callback(on_progress, nullptr);

  sd_ctx_params_t cp;
  sd_ctx_params_init(&cp);
  cp.model_path = model.c_str();
  // Tiny decoder (TAESD): measured 30 s -> 2 s for the last stage on the laptop, with a near-identical image.
  if (!taesd.empty()) cp.taesd_path = taesd.c_str();
  cp.n_threads = threads;
  cp.enable_mmap = true;  // map the 2 GB file instead of copying it into RAM
  sd_ctx_t* ctx = new_sd_ctx(&cp);
  if (!ctx) return env->NewStringUTF("The image model could not be loaded");
  g_ctx = ctx;

  sd_img_gen_params_t gp;
  sd_img_gen_params_init(&gp);
  gp.prompt = prompt.c_str();
  gp.negative_prompt = "";
  gp.width = width;
  gp.height = height;
  gp.seed = seed;
  gp.batch_count = 1;
  gp.sample_params.sample_steps = steps;
  gp.sample_params.guidance.txt_cfg = 1.0f;  // SD-Turbo is trained for 1-step, guidance-free sampling

  sd_image_t* images = nullptr;
  int n = 0;
  bool ok = generate_image(ctx, &gp, &images, &n);
  g_ctx = nullptr;
  std::string err;
  if (!ok || n < 1 || !images || !images[0].data) {
    err = "Image generation stopped or failed";
  } else if (!stbi_write_png(out.c_str(), images[0].width, images[0].height, images[0].channel, images[0].data,
                             images[0].width * images[0].channel)) {
    err = "The image could not be saved";
  }
  if (images) free_sd_images(images, n);
  free_sd_ctx(ctx);
  return env->NewStringUTF(err.c_str());
}

extern "C" JNIEXPORT void JNICALL Java_com_subbu_localai_AiImageModule_nativeCancel(JNIEnv*, jclass) {
  sd_ctx_t* ctx = g_ctx.load();
  if (ctx) sd_cancel_generation(ctx, SD_CANCEL_ALL);
}

extern "C" JNIEXPORT jint JNICALL Java_com_subbu_localai_AiImageModule_nativeStep(JNIEnv*, jclass) { return g_step.load(); }
