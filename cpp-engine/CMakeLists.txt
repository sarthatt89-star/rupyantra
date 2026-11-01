cmake_minimum_required(VERSION 3.10)
project(rupeyantra_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
add_compile_options(-Wall -Wextra)

file(GLOB ENGINE_SRC ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp)
add_library(rupeyantra_engine STATIC ${ENGINE_SRC})
target_include_directories(rupeyantra_engine PUBLIC include PRIVATE src)

enable_testing()
foreach(t test_core test_simulations)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} rupeyantra_engine)
  add_test(NAME ${t} COMMAND ${t})
endforeach()

# helpers for the C++ vs JS comparison and for timing; not part of the website
add_executable(ry_cli tests/cli.cpp)
target_link_libraries(ry_cli rupeyantra_engine)
add_executable(ry_bench tests/bench.cpp)
target_link_libraries(ry_bench rupeyantra_engine)

# The website uses the WebAssembly build, which GitHub Actions makes (.github/workflows/build-wasm.yml).
