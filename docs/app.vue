<script setup lang="ts">
const { seo } = useAppConfig();

const { data: navigation } = await useAsyncData("navigation", () =>
  fetchContentNavigation()
);

useHead({
  meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
  link: [{ rel: "icon", href: "/favicon.ico" }],
  htmlAttrs: {
    lang: "en",
  },
});

// useSeoMeta({
//   ogSiteName: seo?.siteName,
//   twitterCard: "summary_large_image",
// });

provide("navigation", navigation);
</script>

<template>
  <div>
    <Header />

    <!-- <UMain> -->
    <!-- <NuxtLayout> -->
    Nuxt Concierge
    <!-- <NuxtPage /> -->
    <!-- </NuxtLayout> -->
    <!-- </UMain> -->

    <!-- <Footer /> -->

    <!-- <UNotifications /> -->
  </div>
</template>
