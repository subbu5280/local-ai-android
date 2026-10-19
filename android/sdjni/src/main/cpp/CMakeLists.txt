# On-device image generation: stable-diffusion.cpp built into libsdjni.so, in its own Gradle module so the app's
# React Native native build (autolinking, TurboModules) is never replaced. Source: scripts/fetch-sdcpp.ps1.
cmake_minimum_required(VERSION 3.22)
project(sdjni C CXX)

set(CMAKE_CXX_STANDARD 17)
# llama.rn ships its own ggml in another .so: hide every symbol of this library's static ggml/sd so the two can't clash.
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

set(SD_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/stable-diffusion.cpp)
set(SD_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SD_WEBP OFF CACHE BOOL "" FORCE)
set(SD_WEBM OFF CACHE BOOL "" FORCE)
set(SD_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)  # ggml's own thread pool; NDK OpenMP would add a runtime library
add_subdirectory(${SD_DIR} sd EXCLUDE_FROM_ALL)

add_library(sdjni SHARED sd_jni.cpp)
target_include_directories(sdjni PRIVATE ${SD_DIR}/include ${SD_DIR}/thirdparty)
target_link_libraries(sdjni PRIVATE stable-diffusion log)
target_link_options(sdjni PRIVATE -Wl,--exclude-libs,ALL -Wl,-z,max-page-size=16384)
