import { Stack } from "expo-router";
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,   // 🔔 要跳視覺通知
    shouldPlaySound: false,  // 要不要聲音，看你
    shouldSetBadge: false,
  }),
});

export default function RootLayout() {
  return (
    <>
      {/* Root stack controls screen transitions for the whole app */}
      <Stack>
        {/* The (tabs) group is one Stack screen with its own tab navigator */}
        <Stack.Screen
          name="(tabs)"
          options={{ headerShown: false }}
        />
      </Stack>
    </>
  );
}
