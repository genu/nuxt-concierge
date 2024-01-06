<script lang="ts" setup>
const { data: page } = await useAsyncData("index", () =>
  queryContent("/").findOne()
);
</script>

<template>
  <div>asdf data</div>
</template>
