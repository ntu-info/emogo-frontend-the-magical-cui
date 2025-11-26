import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs>
      {/* First tab uses the index.js screen in this folder */}
      <Tabs.Screen
        name="index"
        options={{
          title: "影像日記",
        }}
      />
      <Tabs.Screen
        name="Settings"
        options={{
          title: "設定與匯出",
        }}
      />
    </Tabs>
  );
}
