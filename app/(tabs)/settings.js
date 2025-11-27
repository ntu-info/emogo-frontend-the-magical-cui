// app/(tabs)/settings.js
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Button,
  StyleSheet,
  Alert,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as Notifications from 'expo-notifications';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

const db = SQLite.openDatabaseSync('data.db');
const VIDEO_DIR = FileSystem.documentDirectory + 'videos/';
const SAF = FileSystem.StorageAccessFramework;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const pad2 = (n) => n.toString().padStart(2, '0');

async function ensureVideoDir() {
  const info = await FileSystem.getInfoAsync(VIDEO_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(VIDEO_DIR, { intermediates: true });
  }
}

/** =========  匯出「只有 CSV」，檔名帶時間戳  ========= */
async function exportToCsv() {
  try {
    const rows = await db.getAllAsync('SELECT * FROM samples;');

    if (!rows || rows.length === 0) {
      Alert.alert('目前沒有資料可以匯出');
      return;
    }

    let csv = 'id,ts,mood,videoUri,lat,lng\n';
    for (const r of rows) {
      const line = [
        r.id,
        r.ts,
        r.mood,
        JSON.stringify(r.videoUri ?? ''),
        r.lat,
        r.lng,
      ].join(',');
      csv += line + '\n';
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fileUri = FileSystem.documentDirectory + `samples_${ts}.csv`;

    await FileSystem.writeAsStringAsync(fileUri, csv, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: '匯出 samples.csv',
      });
    } else {
      Alert.alert('此裝置無法使用分享功能', `檔案位置：${fileUri}`);
    }
  } catch (err) {
    console.log('exportToCsv error', err);
    Alert.alert('匯出失敗', String(err));
  }
}

/** =========  匯出 CSV + 影片，CSV 檔名也帶時間戳 ========= */
async function exportCsvAndVideos() {
  try {
    const rows = await db.getAllAsync('SELECT * FROM samples;');
    if (!rows || rows.length === 0) {
      Alert.alert('目前沒有資料可以匯出');
      return;
    }

    const permissions = await SAF.requestDirectoryPermissionsAsync();
    if (!permissions.granted) {
      Alert.alert('已取消匯出');
      return;
    }
    const dirUri = permissions.directoryUri;

    // CSV
    let csv = 'id,ts,mood,videoUri,lat,lng\n';
    for (const r of rows) {
      const line = [
        r.id,
        r.ts,
        r.mood,
        JSON.stringify(r.videoUri ?? ''),
        r.lat,
        r.lng,
      ].join(',');
      csv += line + '\n';
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFileUri = await SAF.createFileAsync(
      dirUri,
      `samples_${ts}.csv`,
      'text/csv'
    );
    await FileSystem.writeAsStringAsync(csvFileUri, csv, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    // 影片：成功複製後刪掉 app 內那份
    for (const r of rows) {
      if (!r.videoUri) continue;

      try {
        const info = await FileSystem.getInfoAsync(r.videoUri);
        if (!info.exists) {
          console.log('video not found, skip id =', r.id, r.videoUri);
          continue;
        }

        const base64Video = await FileSystem.readAsStringAsync(r.videoUri, {
          encoding: FileSystem.EncodingType.Base64,
        });

        const safeTs = r.ts.replace(/[:.]/g, '-');
        const destVideoUri = await SAF.createFileAsync(
          dirUri,
          `sample_${safeTs}.mp4`,
          'video/mp4'
        );

        await FileSystem.writeAsStringAsync(destVideoUri, base64Video, {
          encoding: FileSystem.EncodingType.Base64,
        });

        await FileSystem.deleteAsync(r.videoUri, { idempotent: true });
      } catch (e) {
        console.log('skip video id =', r.id, 'because:', e);
        continue;
      }
    }

    Alert.alert(
      '匯出完成',
      'samples.csv 與所有影片已寫入選取的資料夾，且已清除 app 內影片暫存。'
    );
  } catch (err) {
    console.log('exportCsvAndVideos error', err);
    Alert.alert('匯出失敗', String(err));
  }
}

export default function SettingsScreen() {
  // 三組提醒時間
  const [reminders, setReminders] = useState([
    { hour: 16, minute: 0 },
    { hour: 21, minute: 0 },
    { hour: 22, minute: 0 },
  ]);

  // 顯示用：通知權限 & 排程中的提醒數
  const [permStatus, setPermStatus] = useState(null);
  const [scheduledCount, setScheduledCount] = useState(0);

  const refreshStatus = async () => {
    try {
      const perm = await Notifications.getPermissionsAsync();
      const status = perm.granted ? 'granted' : perm.status;
      setPermStatus(status);
    } catch (e) {
      console.log('refreshStatus error', e);
    }
  };


  useEffect(() => {
    refreshStatus();
  }, []);


// 放在 SettingsScreen 裡面，取代你現在的 handleSchedulePress

// 算出從「現在」到指定 hour:minute 還有幾秒
function getDelaySeconds(hour, minute) {
  const now = new Date();
  const target = new Date();

  target.setHours(hour, minute, 0, 0);

  // 如果時間已經過了，排到「明天」同一個時間
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const diffMs = target.getTime() - now.getTime();
  return Math.max(5, Math.round(diffMs / 1000)); // 至少 5 秒後
}


// 修正後的 handleSchedulePress 函數
const handleSchedulePress = async () => {
  try {
    // 1) 先向系統要一次權限
    const permReq = await Notifications.requestPermissionsAsync();
    const status = permReq.granted ? 'granted' : permReq.status;
    setPermStatus(status);

    if (status !== 'granted') {
      Alert.alert('通知權限被拒絕', '請到系統設定開啟此 app 的通知。');
      return;
    }

    // 2) 清空舊排程
    await Notifications.cancelAllScheduledNotificationsAsync();

    // 3) 使用正確的 DailyTriggerInput 格式排程每日提醒
    const results = [];

    for (const { hour, minute } of reminders) {
      if (hour == null || minute == null) continue;

      // ✅ 使用 DailyTriggerInput - 這才是正確的每日重複方式
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Time to log a sample',
          body: '請記錄心情 + vlog + GPS',
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: hour,
          minute: minute,
          repeats: true,  // DailyTriggerInput 必須設為 true
        },
      });

      results.push({ hour, minute });
    }

    // 4) 排一個 5 秒後的測試通知(用 TimeIntervalTriggerInput)
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '測試通知',
        body: '如果你看到這個,就代表通知功能正常 ✅',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 5,
      },
    });

    // 5) 更新排程數量
    const n = reminders.filter(
      r => r.hour != null && r.minute != null
    ).length;
    setScheduledCount(n);

    // 6) 顯示結果
    const lines = results.map((r, i) =>
      `提醒 ${i + 1}：每天 ${pad2(r.hour)}:${pad2(r.minute)}`
    );
    Alert.alert(
      '排程成功',
      lines.join('\n') + '\n\n這些通知將每天在設定的時間重複發送。\n\n（測試通知：5 秒後）'
    );

  } catch (e) {
    console.log('schedule error', e);
    Alert.alert('設定提醒失敗', String(e));
  }
};

  const updateReminder = (index, key, value) => {
    setReminders((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [key]: value } : r))
    );
  };

  const renderStatusText = () => {
    if (!permStatus) return '讀取中…';
    if (permStatus === 'granted') return '✅ 已允許';
    if (permStatus === 'denied') return '❌ 已拒絕（請到系統設定開啟）';
    return permStatus;
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Settings</Text>
      <Text style={styles.sectionTitle}>每日提醒時間</Text>

      {[0, 1, 2].map((idx) => (
        <View key={idx} style={styles.row}>
          <Text style={styles.rowLabel}>
            提醒 {idx + 1}{'  '}
            {pad2(reminders[idx].hour)}:{pad2(reminders[idx].minute)}
          </Text>
          <Picker
            style={styles.picker}
            selectedValue={reminders[idx].hour}
            onValueChange={(v) => updateReminder(idx, 'hour', v)}
            dropdownIconColor="#000"
          >
            {HOURS.map((h) => (
              <Picker.Item key={h} label={pad2(h)} value={h} color="#000" />
            ))}
          </Picker>
          <Text style={styles.colon}>:</Text>
          <Picker
            style={styles.picker}
            selectedValue={reminders[idx].minute}
            onValueChange={(v) => updateReminder(idx, 'minute', v)}
            dropdownIconColor="#000"
          >
            {MINUTES.map((m) => (
              <Picker.Item key={m} label={pad2(m)} value={m} color="#000" />
            ))}
          </Picker>
        </View>
      ))}

      <Button
        title="儲存提醒設定並啟用通知"
        onPress={handleSchedulePress}
      />
      <Text style={styles.statusText}>
       
      </Text>
      <Text style={styles.statusText}>
        通知權限：{renderStatusText()}
      </Text>
      <Text style={styles.statusText}>
        目前排程中的每日提醒：{scheduledCount} 個
      </Text>

      <View style={{ height: 24 }} />

      <Button title="匯出 CSV 資料" onPress={exportToCsv} />
      <View style={{ marginTop: 8 }} />
      <Button title="匯出 CSV + 影片到資料夾" onPress={exportCsvAndVideos} />

      <Text style={styles.tip}>
        匯出後會將不同時間心情與位置的紀錄存入 samples_時間.csv，
        並與已記錄之影片存到同一資料夾。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    paddingTop: 32,
    backgroundColor: '#f5f5f5',
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 16,
  },
  statusText: {
    fontSize: 14,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '500',
    marginTop: 16,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  rowLabel: {
    width: 90,
    fontSize: 16,
  },
  colon: {
    marginHorizontal: 4,
    fontSize: 16,
  },
  picker: {
    flex: 1,
    height: 52,
  },
  tip: {
    marginTop: 16,
    fontSize: 12,
    color: '#444',
  },
});
