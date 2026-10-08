import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { directoryRpc, openRpc } from "../shared/contracts.js";

function DirectoryButton({
  label,
  value,
  onPress,
  selected = false,
  disabled = false,
  style,
  textStyle,
}: {
  label: string;
  value?: string;
  onPress(value?: string): void;
  selected?: boolean;
  disabled?: boolean;
  style: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}) {
  const press = useCallback(() => onPress(value), [onPress, value]);
  const state = useMemo(() => ({ selected, disabled }), [selected, disabled]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={state}
      disabled={disabled}
      onPress={press}
      style={style}
    >
      <Text numberOfLines={2} style={textStyle}>
        {label}
      </Text>
    </Pressable>
  );
}

export function DesktopDirectory({ theme, layout, navigation, host }: PluginScreenProps) {
  const directory = useRpc(directoryRpc);
  const open = useRpc(openRpc);
  const [project, setProject] = useState<string>();
  const query = useQuery({
    queryKey: ["desktop-directory", host.id],
    queryFn: () => directory({}),
    refetchInterval: 10000,
  });
  const launch = useMutation({
    mutationFn: open,
    onSuccess: (result) => navigation?.openAgent({ agentId: result.agentId, serverId: host.id }),
  });
  const selected = project ?? query.data?.projects[0]?.name;
  const disabled = launch.isPending || !navigation;
  const { mutate } = launch;
  const { refetch } = query;
  const openThread = useCallback(
    (threadId?: string) => {
      if (selected)
        mutate({
          project: selected,
          threadId,
          requestKey: `${Date.now()}-${Math.random()}`,
        });
    },
    [selected, mutate],
  );
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const colors = theme.colors;
  const styles = useMemo(() => {
    const row = { padding: 16, borderRadius: 12, marginBottom: 10 };
    return StyleSheet.create({
      root: { flex: 1, backgroundColor: colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
      heading: { fontSize: 24, fontWeight: "600", color: colors.foreground },
      muted: { color: colors.foregroundMuted },
      projects: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
      row: { ...row, backgroundColor: colors.surface1 },
      accentRow: { ...row, backgroundColor: colors.accent },
      createRow: { ...row, backgroundColor: colors.accent, opacity: disabled ? 0.5 : 1 },
      text: { fontSize: 16, color: colors.foreground },
      accentText: { color: colors.accentForeground },
      createText: { color: colors.accentForeground, textAlign: "center" },
      error: { color: colors.statusDanger },
    });
  }, [colors, layout.compact, disabled]);
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>电脑上的项目与对话</Text>
      <Text style={styles.muted}>
        选择对话后，在 Paseo 聊天页继续。消息会进入同一个 Codex Desktop 会话。
      </Text>
      <View style={styles.projects}>
        {query.data?.projects.map((entry) => (
          <DirectoryButton
            key={entry.projectId}
            label={entry.name}
            value={entry.name}
            selected={selected === entry.name}
            onPress={setProject}
            style={selected === entry.name ? styles.accentRow : styles.row}
            textStyle={selected === entry.name ? styles.accentText : styles.text}
          />
        ))}
      </View>
      {query.isPending || launch.isPending ? <ActivityIndicator color={colors.accent} /> : null}
      <DirectoryButton
        label="＋ 新建对话"
        disabled={disabled || !selected}
        onPress={openThread}
        style={styles.createRow}
        textStyle={styles.createText}
      />
      {query.data?.threads
        .filter((thread) => thread.project === selected)
        .map((thread) => (
          <DirectoryButton
            key={thread.threadId}
            label={thread.title || "未命名对话"}
            value={thread.threadId}
            disabled={disabled}
            onPress={openThread}
            style={styles.row}
            textStyle={styles.text}
          />
        ))}
      {query.data && !query.data.projects.length ? (
        <Text style={styles.muted}>暂无通过 bridge 授权的 Desktop 项目。</Text>
      ) : null}
      {query.error || launch.error ? (
        <Text selectable style={styles.error}>
          {String(query.error ?? launch.error)}
        </Text>
      ) : null}
      {!navigation ? <Text style={styles.error}>请更新 Paseo App，以打开原生聊天页。</Text> : null}
      <DirectoryButton
        label="刷新列表"
        onPress={refresh}
        style={styles.row}
        textStyle={styles.text}
      />
    </ScrollView>
  );
}
