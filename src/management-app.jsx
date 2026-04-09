import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import {
  Alert,
  App,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Layout,
  Row,
  Col,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Popconfirm,
  Tag,
  Typography,
  theme,
} from "antd";

const { Header, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

const apiBase = "/api";
const workflowSteps = ["register", "login", "tokenCreate", "tokenList"];

function stepLabel(step) {
  return {
    register: "注册",
    login: "登录",
    tokenCreate: "创建 Token",
    tokenList: "查询 Token",
    checkin: "签到",
  }[step] || step;
}

function statusClass(status) {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "idle";
}

function statusTag(status) {
  const normalized = statusClass(status);
  if (normalized === "success") return <Tag color="#00ff41" style={{ color: "#000", border: "none", fontWeight: "bold", borderRadius: 0 }}>SUCCESS</Tag>;
  if (normalized === "failed") return <Tag color="#ff003c" style={{ color: "#fff", border: "none", fontWeight: "bold", borderRadius: 0 }}>FAILED</Tag>;
  return <Tag style={{ borderRadius: 0, background: "#222", color: "#888", border: "1px solid #333" }}>IDLE</Tag>;
}

function workflowMessage(detail) {
  if (detail && detail.status === "success") {
    return detail.message || "执行成功";
  }
  if (detail && detail.status === "failed") {
    return detail.message || "执行失败";
  }
  return "待执行";
}

function checkinTag(checkinStatus) {
  if (checkinStatus && checkinStatus.checkedInToday === true) {
    return <Tag color="#00ff41" style={{ color: "#000", border: "none", fontWeight: "bold", borderRadius: 0 }}>CHECKED IN</Tag>;
  }
  if (checkinStatus && checkinStatus.updatedAt) {
    return <Tag color="#ffb000" style={{ color: "#000", border: "none", fontWeight: "bold", borderRadius: 0 }}>PENDING</Tag>;
  }
  return <Tag style={{ borderRadius: 0, background: "#222", color: "#888", border: "1px solid #333" }}>UNKNOWN</Tag>;
}

function formatTime(value) {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleString("zh-CN");
  } catch {
    return String(value);
  }
}

function quotaToUsd(quota) {
  const amount = ((Number(quota) || 0) * 2) / 1000000;
  return "$" + amount.toFixed(2);
}

function getPendingWorkflowSteps(account) {
  const workflow = account.workflow || {};
  const firstIncompleteIndex = workflowSteps.findIndex(function (step) {
    return !workflow[step] || workflow[step].status !== "success";
  });

  if (firstIncompleteIndex === -1) {
    return [];
  }

  return workflowSteps.slice(firstIncompleteIndex);
}

function adminHeaders() {
  return {};
}

async function request(path, options) {
  const response = await fetch(path, options || {});
  const data = await response.json().catch(function () {
    return {};
  });

  if (!response.ok) {
    throw new Error(data.error || ("HTTP " + response.status));
  }

  return data;
}

async function requestCheckinStatus(username) {
  return request(apiBase + "/accounts/" + encodeURIComponent(username) + "/checkin-status", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, adminHeaders()),
    body: JSON.stringify({}),
  });
}

async function requestUploadTokens() {
  return request(apiBase + "/tokens/upload", {
    method: "POST",
    headers: adminHeaders(),
  });
}

async function requestRegisterStatus() {
  return request(apiBase + "/registers/status", {
    headers: adminHeaders(),
  });
}

async function requestCheckinTaskStatus() {
  return request(apiBase + "/checkins/status", {
    headers: adminHeaders(),
  });
}

async function requestStatusRefreshTaskStatus() {
  return request(apiBase + "/status", {
    headers: adminHeaders(),
  });
}

function buildStats(summary, balanceSnapshot) {
  const allSummary = (summary && summary.all) || {};
  const remainingQuota = Number(balanceSnapshot && balanceSnapshot.totalQuota) || 0;
  const usedQuota = Number(balanceSnapshot && balanceSnapshot.totalUsedQuota) || 0;
  const totalQuota = remainingQuota + usedQuota;

  return {
    total: allSummary.total || 0,
    failed: allSummary.failed || 0,
    success: allSummary.success || 0,
    updated: allSummary.updated || null,
    checkinDone: allSummary.checkinDone || 0,
    checkinPending: allSummary.checkinPending || 0,
    checkinUnknown: allSummary.checkinUnknown || 0,
    filteredPending: (summary && summary.filtered && summary.filtered.pendingCheckin) || 0,
    balanceRemaining: balanceSnapshot && balanceSnapshot.totalBalance ? balanceSnapshot.totalBalance : quotaToUsd(remainingQuota),
    balanceUsed: balanceSnapshot && balanceSnapshot.totalUsedBalance ? balanceSnapshot.totalUsedBalance : quotaToUsd(usedQuota),
    balanceTotal: quotaToUsd(totalQuota),
    balanceUpdated: formatTime(balanceSnapshot && balanceSnapshot.updatedAt),
  };
}

function registerStatusAlertProps(registerTask) {
  if (!registerTask) {
    return {
      type: "info",
      message: "批量注册任务准备就绪",
      description: "点击“批量注册”后将立即返回，任务在后台异步执行。",
    };
  }

  if (registerTask.running) {
    return {
      type: "info",
      message: "批量注册任务后台运行中",
      description: "当前请求数量 " + (registerTask.requestedCount || 0) + "，管理页会自动轮询最新状态。",
    };
  }

  if (registerTask.error) {
    return {
      type: "error",
      message: "批量注册任务执行失败",
      description: registerTask.error,
    };
  }

  if (registerTask.finishedAt) {
    const summary = registerTask.summary || {};
    return {
      type: "success",
      message: "批量注册任务已完成",
      description: "本次请求 " + (registerTask.requestedCount || 0) + " 个账号，成功返回结果。",
    };
  }

  return {
    type: "info",
    message: "批量注册任务准备就绪",
    description: "点击“批量注册”后将立即返回，任务在后台异步执行。",
  };
}

function backgroundTaskAlertProps(task, options) {
  if (!task) {
    return {
      type: "info",
      message: options.idleMessage,
      description: options.idleDescription,
    };
  }

  if (task.running) {
    return {
      type: "info",
      message: options.runningMessage,
      description: options.runningDescription,
    };
  }

  if (task.error) {
    return {
      type: "error",
      message: options.errorMessage,
      description: task.error,
    };
  }

  if (task.finishedAt) {
    return {
      type: "success",
      message: options.finishedMessage,
      description: options.finishedDescription,
    };
  }

  return {
    type: "info",
    message: options.idleMessage,
    description: options.idleDescription,
  };
}

function checkinStatusAlertProps(checkinTask) {
  return backgroundTaskAlertProps(checkinTask, {
    idleMessage: "批量签到任务准备就绪",
    idleDescription: "点击后会立即返回，签到任务在后台异步执行。",
    runningMessage: "批量签到任务后台运行中",
    runningDescription: "管理页会自动轮询任务状态，并在完成后刷新账号列表。",
    errorMessage: "批量签到任务执行失败",
    finishedMessage: "批量签到任务已完成",
    finishedDescription: "最近一次后台签到任务已经结束。",
  });
}

function balanceStatusAlertProps(balanceTask) {
  return backgroundTaskAlertProps(balanceTask, {
    idleMessage: "状态刷新任务准备就绪",
    idleDescription: "点击后会立即返回，状态刷新在后台异步执行。",
    runningMessage: "状态刷新任务后台运行中",
    runningDescription: "管理页会自动轮询任务状态，并在完成后刷新余额、签到状态与账号列表。",
    errorMessage: "状态刷新任务执行失败",
    finishedMessage: "状态刷新任务已完成",
    finishedDescription: "最近一次后台状态刷新已经结束。",
  });
}

function AccountWorkflow({ account }) {
  const workflow = account.workflow || {};
  const hasToken = Boolean(account.token);
  const checkinStatus = account.checkinStatus || {};
  const visibleSteps = getPendingWorkflowSteps(account);

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      {!hasToken && visibleSteps.map(function (step) {
        const detail = workflow[step] || {};
        return (
          <Card key={step} size="small" bordered={false} style={{ background: "#111", border: "1px solid #333", borderRadius: 0 }}>
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <Text strong style={{ color: "#fff", fontFamily: "monospace", textTransform: "uppercase" }}>{stepLabel(step)}</Text>
                {statusTag(detail.status)}
              </Space>
              <Text style={{ color: "#aaa", fontFamily: "monospace", fontSize: 12 }}>{workflowMessage(detail)}</Text>
              <Space size={8} wrap>
                <Text style={{ color: "#666", fontFamily: "monospace", fontSize: 12 }}>[TIME]: {formatTime(detail.lastRunAt)}</Text>
                <Text style={{ color: "#666", fontFamily: "monospace", fontSize: 12 }}>[CODE]: {detail.httpStatus == null ? "NULL" : detail.httpStatus}</Text>
              </Space>
            </Space>
          </Card>
        );
      })}

      {hasToken ? <Alert type="success" showIcon={false} message="[SYS] TOKEN AQUIRED. WORKFLOW FOLDED." style={{ background: "rgba(0, 255, 65, 0.1)", border: "1px solid #00ff41", color: "#00ff41", borderRadius: 0, fontFamily: "monospace" }} /> : null}

      <Card size="small" bordered={false} style={{ background: "#111", border: "1px solid #333", borderRadius: 0 }}>
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Space style={{ justifyContent: "space-between", width: "100%" }}>
            <Text strong style={{ color: "#fff", fontFamily: "monospace" }}>[CHECK-IN STATUS]</Text>
            {checkinTag(checkinStatus)}
          </Space>
          <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#666", fontFamily: "monospace" }}>
            <Descriptions.Item label="[MONTHLY_COUNT]"><span style={{ color: "#fff", fontFamily: "monospace" }}>{checkinStatus.totalCheckins == null ? 0 : checkinStatus.totalCheckins}</span></Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>
    </Space>
  );
}

function CredentialsCell({ account }) {
  const hasLocalSession = Boolean(account.session);

  return (
    <Card size="small" bordered={false} style={{ background: "#111", border: "1px solid #333", borderRadius: 0 }}>
      <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#666", fontFamily: "monospace" }}>
        <Descriptions.Item label="[TOKEN]">
          <Typography.Paragraph copyable ellipsis={{ rows: 2, expandable: true, symbol: "展开" }} style={{ marginBottom: 0, color: "#00ff41", fontFamily: "monospace", fontSize: 12 }}>
            {account.token || "NULL"}
          </Typography.Paragraph>
        </Descriptions.Item>
        <Descriptions.Item label="[SESSION]">
          {hasLocalSession ? <span style={{ color: "#00ff41", fontFamily: "monospace" }}>EXISTS</span> : <span style={{ color: "#666", fontFamily: "monospace" }}>MISSING</span>}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function BalanceCell({ account }) {
  const remainingQuota = Number(account.lastBalanceQuota) || 0;
  const usedQuota = Number(account.lastUsedQuota) || 0;
  const currentBalanceDisplay = account.lastBalance || quotaToUsd(remainingQuota);
  const usedBalanceDisplay = account.lastUsedBalance || quotaToUsd(usedQuota);

  return (
    <Card size="small" bordered={false} style={{ background: "#111", border: "1px solid #333", borderRadius: 0 }} bodyStyle={{ padding: 4 }}>
      <Space direction="vertical" size={2} style={{ width: "100%" }}>
        <Statistic 
          title={<span style={{ color: "#666", fontFamily: "monospace", fontSize: 12 }}>[BALANCE]</span>} 
          value={currentBalanceDisplay} 
          valueStyle={{ color: "#fff", fontFamily: "monospace", fontWeight: "bold", fontSize: 14 }} 
        />
        <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#666", fontFamily: "monospace" }}>
          <Descriptions.Item label="[USED]"><span style={{ color: "#888", fontFamily: "monospace", fontSize: 12 }}>{usedBalanceDisplay}</span></Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}

function AccountCell({ account }) {
  return (
    <Card size="small" bordered={false} style={{ background: "transparent", border: "none" }} bodyStyle={{ padding: 4 }}>
      <Space direction="vertical" size={2} style={{ width: "100%" }}>
        <Text strong style={{ fontSize: 14, fontFamily: "monospace", color: "#fff", letterSpacing: 1 }}>{account.username || "UNKNOWN_USER"}</Text>
        <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#666", fontFamily: "monospace" }}>
          <Descriptions.Item label="[UPDATED]"><span style={{ color: "#888", fontFamily: "monospace", fontSize: 12 }}>{formatTime(account.updatedAt)}</span></Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}

function ActionCell({ account, onRetry, onRefreshCheckin, onManualCheckin, onDelete, rowBusy }) {
  const workflow = account.workflow || {};
  const hasToken = Boolean(account.token);
  const actionableSteps = getPendingWorkflowSteps(account).filter(function (step) {
    return !workflow[step] || workflow[step].status !== "success";
  });

  return (
    <Card size="small" bordered={false} style={{ background: "transparent", border: "none" }}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {!hasToken ? (
          <Space wrap>
            {actionableSteps.length ? actionableSteps.map(function (step) {
              const detail = workflow[step] || {};
              const isFailed = detail.status === "failed";
              return (
                <Button key={step} size="small" style={{ borderRadius: 0, fontFamily: "monospace", textTransform: "uppercase", background: isFailed ? "rgba(255, 0, 60, 0.1)" : "rgba(255, 255, 255, 0.1)", borderColor: isFailed ? "#ff003c" : "#333", color: isFailed ? "#ff003c" : "#fff" }} onClick={function () { onRetry(account.username, step); }} loading={rowBusy === account.username + ":retry:" + step}>
                  {isFailed ? "RETRY " : "EXEC "}{stepLabel(step)}
                </Button>
              );
            }) : <Text style={{ color: "#666", fontFamily: "monospace" }}>[WORKFLOW COMPLETE]</Text>}
          </Space>
        ) : null}
        <Space wrap>
          <Button size="small" style={{ borderRadius: 0, fontFamily: "monospace", background: "rgba(255, 255, 255, 0.05)", borderColor: "#444", color: "#ccc" }} onClick={function () { onRefreshCheckin(account.username); }} loading={rowBusy === account.username + ":refresh-checkin"}>
            REFRESH
          </Button>
          {account.checkinStatus && account.checkinStatus.checkedInToday ? (
            <Tag color="#00ff41" style={{ color: "#000", border: "none", fontWeight: "bold", borderRadius: 0 }}>DONE TODAY</Tag>
          ) : (
            <Button size="small" type="primary" style={{ borderRadius: 0, fontFamily: "monospace", background: "#00ff41", borderColor: "#00ff41", color: "#000", fontWeight: "bold" }} onClick={function () { onManualCheckin(account.username); }} loading={rowBusy === account.username + ":manual-checkin"}>
              FORCE CHECK-IN
            </Button>
          )}
          <Popconfirm title="DELETE ACCOUNT?" onConfirm={function() { onDelete(account.username); }} okText="YES" cancelText="NO">
            <Button size="small" danger style={{ borderRadius: 0, fontFamily: "monospace", background: "rgba(255,0,0,0.1)", borderColor: "#ff003c" }} loading={rowBusy === account.username + ":delete"}>
              DEL
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Card>
  );
}

function TerminalWindow({ title, children }) {
  return (
    <div style={{ border: "1px solid #333", background: "#0a0a0a", display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "4px 12px", background: "#222", borderBottom: "1px solid #333", display: "flex", alignItems: "center" }}>
        <Text strong style={{ color: "#00ff41", fontFamily: "monospace", fontSize: 12, letterSpacing: 1 }}>{title}</Text>
      </div>
      <div style={{ padding: 16, flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

function GlobalStyles() {
  return (
    <style>{`
      body {
        margin: 0;
        background-color: #050505 !important;
        background-image: 
          linear-gradient(rgba(0, 255, 65, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0, 255, 65, 0.03) 1px, transparent 1px);
        background-size: 20px 20px;
        color: #e0e0e0;
      }
      .ant-layout { background: transparent !important; }
      .ant-card { border-radius: 0 !important; }
      .ant-btn { border-radius: 0 !important; text-transform: uppercase; font-family: monospace; letter-spacing: 0.5px; }
      .ant-alert { border-radius: 0 !important; font-family: monospace; }
      .ant-table-wrapper { background: #0a0a0a; border: 1px solid #333; }
      .ant-table { background: transparent !important; }
      .ant-table-thead > tr > th { font-family: monospace; text-transform: uppercase; letter-spacing: 1px; }
      .ant-table-tbody > tr > td { border-bottom: 1px solid #222 !important; }
      ::selection { background: rgba(0, 255, 65, 0.3); color: #fff; }
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: #050505; border-left: 1px solid #222; }
      ::-webkit-scrollbar-thumb { background: #333; border: 1px solid #444; }
      ::-webkit-scrollbar-thumb:hover { background: #00ff41; }
    `}</style>
  );
}

function Dashboard() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [accountsSummary, setAccountsSummary] = useState(null);
  const [balanceSnapshot, setBalanceSnapshot] = useState(null);
  const [checkinTask, setCheckinTask] = useState(null);
  const [balanceTask, setBalanceTask] = useState(null);
  const [registerTask, setRegisterTask] = useState(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [registerCount, setRegisterCount] = useState(5);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10000, total: 0 });
  const [filters, setFilters] = useState({
    keyword: "",
    statusMode: "all",
    step: "all",
  });

  const stats = useMemo(function () {
    return buildStats(accountsSummary, balanceSnapshot);
  }, [accountsSummary, balanceSnapshot]);

  const registerAlert = useMemo(function () {
    return registerStatusAlertProps(registerTask);
  }, [registerTask]);

  const checkinAlert = useMemo(function () {
    return checkinStatusAlertProps(checkinTask);
  }, [checkinTask]);

  const balanceAlert = useMemo(function () {
    return balanceStatusAlertProps(balanceTask);
  }, [balanceTask]);

  const selectedAccounts = useMemo(function () {
    return accounts.filter(function (account) {
      return selectedRowKeys.includes(account.username);
    });
  }, [accounts, selectedRowKeys]);

  const visibleFailedActions = useMemo(function () {
    if (filters.step === "checkin") return [];
    const actions = [];

    accounts.forEach(function (account) {
      workflowSteps.forEach(function (step) {
        if (filters.step !== "all" && filters.step !== step) return;
        if (account.workflow && account.workflow[step] && account.workflow[step].status === "failed") {
          actions.push({ username: account.username, step });
        }
      });
    });

    return actions;
  }, [accounts, filters.step]);

  const selectedFailedActions = useMemo(function () {
    return visibleFailedActions.filter(function (item) {
      return selectedRowKeys.includes(item.username);
    });
  }, [visibleFailedActions, selectedRowKeys]);

  const visibleNeedCheckin = useMemo(function () {
    return accounts.filter(function (account) {
      return !(account.checkinStatus && account.checkinStatus.checkedInToday);
    }).length;
  }, [accounts]);

  const selectedNeedCheckin = useMemo(function () {
    return selectedAccounts.filter(function (account) {
      return !(account.checkinStatus && account.checkinStatus.checkedInToday);
    }).length;
  }, [selectedAccounts]);

  async function loadAccounts(silent, nextPage, nextPageSize, nextFilters) {
    const page = nextPage || pagination.current;
    const pageSize = 10000;
    const activeFilters = nextFilters || filters;

    if (!silent) setLoading(true);
    try {
      const balanceData = await request(apiBase + "/balances");
      const searchParams = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        keyword: activeFilters.keyword || "",
        statusMode: activeFilters.statusMode || "all",
        step: activeFilters.step || "all",
      });
      const data = await request(apiBase + "/accounts?" + searchParams.toString(), {
        headers: adminHeaders(),
      });
      setBalanceSnapshot(balanceData || null);
      setAccountsSummary(data.summary || null);
      setAccounts(data.accounts || []);
      setPagination({ current: data.page || page, pageSize: data.pageSize || pageSize, total: data.total || 0 });
      setSelectedRowKeys([]);
    } catch (error) {
      setBalanceSnapshot(null);
      message.error(error.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadRegisterStatus(silent) {
    try {
      const data = await requestRegisterStatus();
      setRegisterTask(data || null);
      return data || null;
    } catch (error) {
      if (!silent) {
        message.error(error.message);
      }
      return null;
    }
  }

  async function loadCheckinTaskStatus(silent) {
    try {
      const data = await requestCheckinTaskStatus();
      setCheckinTask(data || null);
      return data || null;
    } catch (error) {
      if (!silent) {
        message.error(error.message);
      }
      return null;
    }
  }

  async function loadBalanceTaskStatus(silent) {
    try {
      const data = await requestStatusRefreshTaskStatus();
      setBalanceTask(data || null);
      return data || null;
    } catch (error) {
      if (!silent) {
        message.error(error.message);
      }
      return null;
    }
  }

  useEffect(function () {
    void loadAccounts();
    void loadRegisterStatus(true);
    void loadCheckinTaskStatus(true);
    void loadBalanceTaskStatus(true);
  }, []);

  useEffect(function () {
    if (!(registerTask && registerTask.running)) {
      return undefined;
    }

    const timer = window.setInterval(function () {
      void loadRegisterStatus(true).then(function (data) {
        if (data && !data.running) {
          void loadAccounts(true, 1, pagination.pageSize, filters);
        }
      });
    }, 3000);

    return function () {
      window.clearInterval(timer);
    };
  }, [registerTask && registerTask.running, pagination.pageSize, filters]);

  useEffect(function () {
    if (!(checkinTask && checkinTask.running)) {
      return undefined;
    }

    const timer = window.setInterval(function () {
      void loadCheckinTaskStatus(true).then(function (data) {
        if (data && !data.running) {
          void loadAccounts(true, pagination.current, pagination.pageSize, filters);
        }
      });
    }, 3000);

    return function () {
      window.clearInterval(timer);
    };
  }, [checkinTask && checkinTask.running, pagination.current, pagination.pageSize, filters]);

  useEffect(function () {
    if (!(balanceTask && balanceTask.running)) {
      return undefined;
    }

    const timer = window.setInterval(function () {
      void loadBalanceTaskStatus(true).then(function (data) {
        if (data && !data.running) {
          void loadAccounts(true, pagination.current, pagination.pageSize, filters);
        }
      });
    }, 3000);

    return function () {
      window.clearInterval(timer);
    };
  }, [balanceTask && balanceTask.running, pagination.current, pagination.pageSize, filters]);

  useEffect(function () {
    const timer = window.setTimeout(function () {
      void loadAccounts(false, 1, pagination.pageSize, filters);
    }, 250);

    return function () {
      window.clearTimeout(timer);
    };
  }, [filters.keyword, filters.statusMode, filters.step]);

  async function handleRetry(username, step) {
    const key = username + ":retry:" + step;
    setBusyKey(key);
    try {
      await request(apiBase + "/accounts/" + encodeURIComponent(username) + "/retry", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, adminHeaders()),
        body: JSON.stringify({ step }),
      });
      message.success(username + " 的" + stepLabel(step) + "已重新执行");
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function handleRefreshCheckin(username) {
    const key = username + ":refresh-checkin";
    setBusyKey(key);
    try {
      await requestCheckinStatus(username);
      message.success(username + " 的签到状态已刷新");
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function handleManualCheckin(username) {
    const key = username + ":manual-checkin";
    setBusyKey(key);
    try {
      await request(apiBase + "/accounts/" + encodeURIComponent(username) + "/checkin", {
        method: "POST",
        headers: adminHeaders(),
      });
      message.success(username + " 已执行签到");
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function handleDelete(username) {
    const key = username + ":delete";
    setBusyKey(key);
    try {
      await request(apiBase + "/accounts/" + encodeURIComponent(username), {
        method: "DELETE",
        headers: adminHeaders(),
      });
      message.success(username + " 已删除");
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function refreshCheckinStatuses(accounts, options) {
    if (!accounts.length) {
      message.info("当前筛选结果里没有账号可刷新签到状态");
      return;
    }

    setBusyKey("refresh-checkin-visible");
    let successCount = 0;
    let failedCount = 0;

    for (let index = 0; index < accounts.length; index += 1) {
      try {
        await requestCheckinStatus(accounts[index].username);
        successCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    if (!(options && options.skipDoneMessage)) {
      message.success("签到状态刷新完成：成功 " + successCount + "，失败 " + failedCount);
    }
    if (!(options && options.skipReload)) {
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    }
    setBusyKey("");
  }

  async function checkinMany(accounts) {
    setBusyKey("checkin-many");
    try {
      const data = await request(apiBase + "/checkins", {
        method: "POST",
        headers: adminHeaders(),
      });
      if (data.alreadyRunning) {
        message.info("批量签到任务已在后台运行中");
      } else {
        message.success("批量签到任务已启动，后台处理中");
      }
      setCheckinTask(data || null);
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function retryMany(actions) {
    if (!actions.length) {
      message.info("当前没有失败项可重试");
      return;
    }

    setBusyKey("retry-many");
    let successCount = 0;
    let failedCount = 0;

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      try {
        await request(apiBase + "/accounts/" + encodeURIComponent(action.username) + "/retry", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, adminHeaders()),
          body: JSON.stringify({ step: action.step }),
        });
        successCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    message.success("批量重试完成：成功 " + successCount + "，失败 " + failedCount);
    await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    setBusyKey("");
  }

  async function handleRegister() {
    setBusyKey("register");
    try {
      const data = await request(apiBase + "/registers", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, adminHeaders()),
        body: JSON.stringify({ count: Number(registerCount || 0) || 1 }),
      });
      const requestedCount = Number(data.requestedCount) || Number(registerCount || 0) || 1;
      if (data.alreadyRunning) {
        message.info("批量注册任务已在后台运行中");
      } else {
        message.success("批量注册任务已启动，后台处理中：请求 " + requestedCount + " 个账号");
      }
      setRegisterTask(data || null);
      await loadAccounts(true, 1, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function handleUploadTokens() {
    setBusyKey("upload-tokens");
    try {
      const data = await requestUploadTokens();
      message.success("Token 上传完成，去重后共上传 " + (((data.result || {}).tokenCount) || 0) + " 个");
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  async function handleRefreshAll() {
    setBusyKey("refresh-all");
    try {
      const data = await request(apiBase + "/status/refresh", {
        method: "POST",
        headers: adminHeaders(),
      });
      if (data.alreadyRunning) {
        message.info("状态刷新任务已在后台运行中");
      } else {
        message.success("状态刷新任务已启动，后台处理中");
      }
      setBalanceTask(data || null);
      await loadAccounts(true, pagination.current, pagination.pageSize, filters);
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusyKey("");
    }
  }

  const columns = [
    {
      title: <span style={{ color: "#888", fontFamily: "monospace" }}>[ID]</span>,
      dataIndex: "username",
      key: "account",
      width: 160,
      render: function (_, record) {
        return <AccountCell account={record} />;
      },
    },
    {
      title: <span style={{ color: "#888", fontFamily: "monospace" }}>[WORKFLOW_STATE]</span>,
      dataIndex: "workflow",
      key: "workflow",
      width: 280,
      render: function (_, record) {
        return <AccountWorkflow account={record} />;
      },
    },
    {
      title: <span style={{ color: "#888", fontFamily: "monospace" }}>[CREDENTIALS]</span>,
      dataIndex: "token",
      key: "credentials",
      width: 240,
      render: function (_, record) {
        return <CredentialsCell account={record} />;
      },
    },
    {
      title: <span style={{ color: "#888", fontFamily: "monospace" }}>[FUNDS]</span>,
      dataIndex: "balance",
      key: "balance",
      width: 200,
      render: function (_, record) {
        return <BalanceCell account={record} />;
      },
    },
    {
      title: <span style={{ color: "#888", fontFamily: "monospace" }}>[EXECUTE]</span>,
      dataIndex: "actions",
      key: "actions",
      width: 200,
      render: function (_, record) {
        return (
          <ActionCell
            account={record}
            onRetry={handleRetry}
            onRefreshCheckin={handleRefreshCheckin}
            onManualCheckin={handleManualCheckin}
            onDelete={handleDelete}
            rowBusy={busyKey}
          />
        );
      },
    },
  ];

  return (
    <Layout style={{ minHeight: "100vh", background: "#f5f5f5" }}>
      <Header style={{ background: "#fff", borderBottom: "1px solid #f0f0f0", padding: "0 24px" }}>
        <Space direction="vertical" size={0} style={{ height: "100%", justifyContent: "center" }}>
          <Title level={4} style={{ margin: 0 }}>账户状态面板</Title>
          <Text type="secondary">使用 Ant Design 默认样式展示注册、登录、Token、签到与余额状态</Text>
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card>
                <Title level={5}>控制台</Title>
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  查看每个账号的流程状态、签到状态、凭据和余额。失败步骤可以直接重试，刷新状态会同步刷新签到信息。
                </Paragraph>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Row gutter={[16, 16]}>
                <Col span={12}><Card><Statistic title="账号总数" value={stats.total} /></Card></Col>
                <Col span={12}><Card><Statistic title="存在失败" value={stats.failed} /></Card></Col>
                <Col span={12}><Card><Statistic title="完整成功" value={stats.success} /></Card></Col>
                <Col span={12}><Card><Statistic title="缓存更新时间" value={stats.updated} valueStyle={{ fontSize: 16 }} /></Card></Col>
              </Row>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} xl={6}><Card><Statistic title="今日已签到" value={stats.checkinDone} /></Card></Col>
            <Col xs={24} md={12} xl={6}><Card><Statistic title="今日未签到" value={stats.checkinPending} /></Card></Col>
            <Col xs={24} md={12} xl={6}><Card><Statistic title="签到状态未知" value={stats.checkinUnknown} /></Card></Col>
            <Col xs={24} md={12} xl={6}><Card><Statistic title="当前筛选未签到" value={stats.filteredPending} /></Card></Col>
            <Col xs={24} md={8}><Card><Statistic title="当前总余额" value={stats.balanceRemaining} /></Card></Col>
            <Col xs={24} md={8}><Card><Statistic title="总使用余额" value={stats.balanceUsed} /></Card></Col>
            <Col xs={24} md={8}><Card><Statistic title="总余额" value={stats.balanceTotal} /></Card></Col>
            <Col span={24}><Card><Statistic title="上次余额同步时间" value={stats.balanceUpdated} valueStyle={{ fontSize: 16 }} /></Card></Col>
          </Row>

          <Card>
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <Space wrap>
                <InputNumber min={1} value={registerCount} onChange={function (value) { setRegisterCount(value || 1); }} />
                <Button type="primary" onClick={handleRegister} loading={busyKey === "register"}>批量注册</Button>
                <Button onClick={handleUploadTokens} loading={busyKey === "upload-tokens"}>上传全部 Token（自动去重）</Button>
              </Space>

              <Row gutter={[16, 16]}>
                <Col xs={24} xl={8}>
                  <Card size="small">
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Alert type={registerAlert.type} message={registerAlert.message} description={registerAlert.description} showIcon />
                      <Descriptions column={2} size="small">
                        <Descriptions.Item label="请求数量">{registerTask && registerTask.requestedCount ? registerTask.requestedCount : "--"}</Descriptions.Item>
                        <Descriptions.Item label="运行状态">
                          {registerTask && registerTask.running ? <Tag color="processing">运行中</Tag> : <Tag color="default">空闲</Tag>}
                        </Descriptions.Item>
                        <Descriptions.Item label="开始时间">{formatTime(registerTask && registerTask.startedAt)}</Descriptions.Item>
                        <Descriptions.Item label="结束时间">{formatTime(registerTask && registerTask.finishedAt)}</Descriptions.Item>
                      </Descriptions>
                    </Space>
                  </Card>
                </Col>
                <Col xs={24} xl={8}>
                  <Card size="small">
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Alert type={checkinAlert.type} message={checkinAlert.message} description={checkinAlert.description} showIcon />
                      <Descriptions column={2} size="small">
                        <Descriptions.Item label="任务类型">批量签到</Descriptions.Item>
                        <Descriptions.Item label="运行状态">
                          {checkinTask && checkinTask.running ? <Tag color="processing">运行中</Tag> : <Tag color="default">空闲</Tag>}
                        </Descriptions.Item>
                        <Descriptions.Item label="开始时间">{formatTime(checkinTask && checkinTask.startedAt)}</Descriptions.Item>
                        <Descriptions.Item label="结束时间">{formatTime(checkinTask && checkinTask.finishedAt)}</Descriptions.Item>
                      </Descriptions>
                    </Space>
                  </Card>
                </Col>
                <Col xs={24} xl={8}>
                  <Card size="small">
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Alert type={balanceAlert.type} message={balanceAlert.message} description={balanceAlert.description} showIcon />
                      <Descriptions column={2} size="small">
                        <Descriptions.Item label="任务类型">余额刷新</Descriptions.Item>
                        <Descriptions.Item label="运行状态">
                          {balanceTask && balanceTask.running ? <Tag color="processing">运行中</Tag> : <Tag color="default">空闲</Tag>}
                        </Descriptions.Item>
                        <Descriptions.Item label="开始时间">{formatTime(balanceTask && balanceTask.startedAt)}</Descriptions.Item>
                        <Descriptions.Item label="结束时间">{formatTime(balanceTask && balanceTask.finishedAt)}</Descriptions.Item>
                      </Descriptions>
                    </Space>
                  </Card>
                </Col>
              </Row>

              <Space wrap>
                <Input
                  style={{ width: 260 }}
                  placeholder="搜索账号 / token / user id"
                  value={filters.keyword}
                  onChange={function (event) {
                    setFilters(Object.assign({}, filters, { keyword: event.target.value }));
                  }}
                />
                <Select
                  style={{ width: 160 }}
                  value={filters.statusMode}
                  options={[
                    { value: "all", label: "全部状态" },
                    { value: "failed-only", label: "仅看失败" },
                    { value: "success-only", label: "仅看全成功" },
                    { value: "idle-only", label: "仅看未执行" },
                    { value: "unchecked-only", label: "仅看未签到" },
                  ]}
                  onChange={function (value) {
                    setFilters(Object.assign({}, filters, { statusMode: value }));
                  }}
                />
                <Select
                  style={{ width: 160 }}
                  value={filters.step}
                  options={[
                    { value: "all", label: "全部步骤" },
                    { value: "register", label: "注册" },
                    { value: "login", label: "登录" },
                    { value: "tokenCreate", label: "创建 Token" },
                    { value: "tokenList", label: "查询 Token" },
                    { value: "checkin", label: "签到" },
                  ]}
                  onChange={function (value) {
                    setFilters(Object.assign({}, filters, { step: value }));
                  }}
                />
                <Button onClick={function () { void refreshCheckinStatuses(accounts); }} loading={busyKey === "refresh-checkin-visible"}>
                  刷新当前页签到状态{accounts.length ? " (" + accounts.length + ")" : ""}
                </Button>
                <Button onClick={function () { void checkinMany(accounts); }} disabled={visibleNeedCheckin === 0} loading={busyKey === "checkin-many"}>
                  为当前页未签到账号签到{visibleNeedCheckin ? " (" + visibleNeedCheckin + ")" : ""}
                </Button>
                <Button onClick={function () { void checkinMany(selectedAccounts); }} disabled={selectedNeedCheckin === 0} loading={busyKey === "checkin-many"}>
                  为所选未签到账号签到{selectedNeedCheckin ? " (" + selectedNeedCheckin + ")" : ""}
                </Button>
                <Button onClick={function () {
                  setSelectedRowKeys(accounts.map(function (account) { return account.username; }));
                }}>
                  选择当前页{accounts.length ? " (" + accounts.length + ")" : ""}
                </Button>
                <Button onClick={function () { setSelectedRowKeys([]); }} disabled={!selectedRowKeys.length}>清空选择</Button>
                <Button onClick={function () { void retryMany(selectedFailedActions); }} disabled={!selectedFailedActions.length} loading={busyKey === "retry-many"}>
                  重试所选失败项{selectedFailedActions.length ? " (" + selectedFailedActions.length + ")" : ""}
                </Button>
                <Button onClick={function () { void retryMany(visibleFailedActions); }} disabled={!visibleFailedActions.length} loading={busyKey === "retry-many"}>
                  重试当前筛选失败项{visibleFailedActions.length ? " (" + visibleFailedActions.length + ")" : ""}
                </Button>
                <Button onClick={handleRefreshAll} loading={busyKey === "refresh-all"}>刷新状态</Button>
              </Space>

              {loading ? (
                <div style={{ textAlign: "center", padding: 48 }}><Spin size="large" /></div>
              ) : !accounts.length ? (
                <Empty description="暂无账号数据，可以先执行一次批量注册或导入旧数据。" />
              ) : (
                <Table
                  rowKey="username"
                  dataSource={accounts}
                  columns={columns}
                  pagination={false}
                  size="small"
                  scroll={{ x: 1600 }}
                  onChange={function (nextPagination) {
                    void loadAccounts(false, nextPagination.current, nextPagination.pageSize, filters);
                  }}
                  rowSelection={{
                    selectedRowKeys,
                    onChange: function (keys) {
                      setSelectedRowKeys(keys);
                    },
                  }}
                />
              )}
            </Space>
          </Card>
        </Space>
      </Content>
    </Layout>
  );
}

function AppRoot() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#00ff41",
          colorBgBase: "#050505",
          colorBgContainer: "#111111",
          colorBgElevated: "#1a1a1a",
          colorBorder: "#333333",
          colorTextBase: "#e0e0e0",
          fontFamily: "'Inter', sans-serif",
          borderRadius: 0,
          wireframe: true,
        },
        components: {
          Card: {
            headerBg: "#111",
            colorBorderSecondary: "#333",
          },
          Table: {
            headerBg: "#0a0a0a",
            headerColor: "#00ff41",
            borderColor: "#222",
            rowHoverBg: "#151515",
          },
          Button: {
            defaultBg: "#111",
            defaultBorderColor: "#444",
            defaultColor: "#fff",
          },
          Input: {
            colorBgContainer: "#0a0a0a",
            colorBorder: "#444",
          },
          Select: {
            colorBgContainer: "#0a0a0a",
            colorBorder: "#444",
          }
        }
      }}
    >
      <App>
        <Dashboard />
      </App>
    </ConfigProvider>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<AppRoot />);
