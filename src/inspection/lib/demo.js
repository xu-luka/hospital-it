'use strict';
/**
 * 演示数据生成器：模拟 4 台服务器的巡检结果，用于验证程序与报告样式
 * 用法：node inspect.js --demo
 */

const { levelOf, worst } = require('./common');

function demoLinuxOk() {
  return {
    ok: true,
    name: 'Web服务器-01',
    host: '192.168.1.101',
    osLabel: 'Linux',
    connectLabel: 'SSH 密码',
    metrics: {
      hostname: 'web-01',
      os: 'Ubuntu 22.04.4 LTS',
      kernel: '5.15.0-112-generic',
      uptime_sec: 864000 + 3600 * 7 + 60 * 23,
      cores: 8,
      load1: 1.2, load5: 0.9, load15: 0.7,
      cpu_percent: 34.5,
      mem_total_mb: 16384, mem_used_mb: 9216, mem_percent: 56.2,
      swap_total_mb: 4096, swap_used_mb: 0,
      procs: 214, zombies: 0,
      disks: [
        { mount: '/', fs: 'ext4', size_mb: 51200, used_mb: 22016, avail_mb: 29184, use_percent: 43 },
        { mount: '/data', fs: 'xfs', size_mb: 512000, used_mb: 327680, avail_mb: 184320, use_percent: 64 }
      ]
    },
    services: [
      { name: 'nginx', type: 'process', running: true, detail: '匹配到 5 个进程' },
      { name: '80', type: 'port', running: true, detail: '端口监听中' },
      { name: '443', type: 'port', running: true, detail: '端口监听中' }
    ],
    customs: [
      { name: '最近登录失败次数', output: '0', code: 0 }
    ]
  };
}

function demoLinuxWarning() {
  return {
    ok: true,
    name: '数据库服务器-01',
    host: '192.168.1.102',
    osLabel: 'Linux',
    connectLabel: 'SSH 密钥',
    metrics: {
      hostname: 'db-01',
      os: 'CentOS Linux 7.9.2009',
      kernel: '3.10.0-1160.el7.x86_64',
      uptime_sec: 8640000 + 3600 * 12,
      cores: 16,
      load1: 12.4, load5: 10.1, load15: 8.6,
      cpu_percent: 78.3,
      mem_total_mb: 65536, mem_used_mb: 56320, mem_percent: 86.0,
      swap_total_mb: 8192, swap_used_mb: 2048,
      procs: 486, zombies: 2,
      disks: [
        { mount: '/', fs: 'ext4', size_mb: 102400, used_mb: 61440, avail_mb: 40960, use_percent: 60 },
        { mount: '/data/mysql', fs: 'xfs', size_mb: 1024000, used_mb: 860160, avail_mb: 163840, use_percent: 84 }
      ]
    },
    services: [
      { name: 'mysqld', type: 'systemd', running: true, detail: 'active' },
      { name: '3306', type: 'port', running: true, detail: '端口监听中' }
    ],
    customs: []
  };
}

function demoWindowsOk() {
  return {
    ok: true,
    name: '应用服务器-01',
    host: '192.168.1.201',
    osLabel: 'Windows',
    connectLabel: 'WinRM',
    metrics: {
      hostname: 'APP-SRV-01',
      os: 'Microsoft Windows Server 2019 Standard',
      kernel: '10.0.17763',
      uptime_sec: 2592000 + 3600 * 5,
      cores: 4,
      load1: null, load5: null, load15: null,
      cpu_percent: 22.8,
      mem_total_mb: 8192, mem_used_mb: 3686, mem_percent: 45.0,
      swap_total_mb: null, swap_used_mb: null,
      procs: 96, zombies: null,
      disks: [
        { mount: 'C:', fs: 'NTFS', size_mb: 81920, used_mb: 45056, avail_mb: 36864, use_percent: 55 },
        { mount: 'D:', fs: 'NTFS', size_mb: 204800, used_mb: 92160, avail_mb: 112640, use_percent: 45 }
      ]
    },
    services: [
      { name: 'W3SVC', type: 'service', running: true, detail: 'Running' },
      { name: '80', type: 'port', running: true, detail: '1 个监听' }
    ],
    customs: []
  };
}

function demoWindowsCritical() {
  return {
    ok: true,
    name: '文件服务器-01',
    host: '192.168.1.202',
    osLabel: 'Windows',
    connectLabel: 'WinRM',
    metrics: {
      hostname: 'FILE-SRV-01',
      os: 'Microsoft Windows Server 2016 Datacenter',
      kernel: '10.0.14393',
      uptime_sec: 86400 * 200,
      cores: 4,
      load1: null, load5: null, load15: null,
      cpu_percent: 93.1,
      mem_total_mb: 16384, mem_used_mb: 15974, mem_percent: 97.5,
      swap_total_mb: null, swap_used_mb: null,
      procs: 180, zombies: null,
      disks: [
        { mount: 'C:', fs: 'NTFS', size_mb: 51200, used_mb: 48640, avail_mb: 2560, use_percent: 95 },
        { mount: 'E:', fs: 'NTFS', size_mb: 1024000, used_mb: 942080, avail_mb: 81920, use_percent: 92 }
      ]
    },
    services: [
      { name: 'LanmanServer', type: 'service', running: true, detail: 'Running' },
      { name: '445', type: 'port', running: false, detail: '0 个监听' }
    ],
    customs: []
  };
}

function demoLinuxFail() {
  return {
    ok: false,
    name: '测试服务器-01',
    host: '10.0.0.99',
    osLabel: 'Linux',
    connectLabel: 'SSH 密码',
    error: '连接超时，请检查网络、IP 和 SSH 端口 (Timed out while waiting for handshake)'
  };
}

function demoBmcOk() {
  return {
    ok: true,
    kind: 'bmc',
    name: '物理机-数据库节点（管理口）',
    host: '10.0.10.20',
    osLabel: '管理口',
    connectLabel: 'Redfish',
    hw: {
      power: 'On',
      manufacturer: 'Inspur',
      model: 'NF5280M6',
      bios: '6.00.21',
      serial: 'SN20230815001',
      cpu_count: 2,
      cpu_health: 'OK',
      mem_gib: 256,
      mem_health: 'OK',
      system_health: 'OK',
      temps: [
        { name: 'CPU1 Temp', reading: 58, health: 'OK' },
        { name: 'CPU2 Temp', reading: 61, health: 'OK' },
        { name: 'Inlet Temp', reading: 24, health: 'OK' }
      ],
      fans: [
        { name: 'Fan1', reading: 5400, health: 'OK' },
        { name: 'Fan2', reading: 5300, health: 'OK' },
        { name: 'Fan3', reading: 8800, health: 'Warning' }
      ],
      psus: [
        { name: 'PSU1', state: 'Enabled', health: 'OK' },
        { name: 'PSU2', state: 'Enabled', health: 'OK' }
      ],
      drives: [
        { name: 'Disk 0', manufacturer: 'Seagate', model: 'ST12000NM001G', serial: 'ZA18KQKQ', media_type: 'HDD', rpm: 7200, capacity: '11179 GB', life_left: null, health: 'OK' },
        { name: 'Disk 1', manufacturer: 'Seagate', model: 'ST12000NM001G', serial: 'ZA18KQP2', media_type: 'HDD', rpm: 7200, capacity: '11179 GB', life_left: null, health: 'OK' },
        { name: 'Disk 2', manufacturer: 'Samsung', model: 'PM893', serial: 'S6GYNM0R100234', media_type: 'SSD', rpm: null, capacity: '894 GB', life_left: 22, health: 'Warning' }
      ],
      events: [
        { time: '2026-08-20T03:12:44', severity: 'Warning', message: 'Fan3 转速超出常规范围' }
      ]
    },
    metrics: {
      hostname: 'db-node-03', os: 'Inspur NF5280M6', kernel: '6.00.21',
      uptime_sec: null, cores: 2, load1: null, load5: null, load15: null,
      cpu_percent: null, mem_total_mb: 262144, mem_used_mb: null, mem_percent: null,
      swap_total_mb: null, swap_used_mb: null, procs: null, zombies: null, disks: []
    },
    services: [],
    customs: []
  };
}

function demoMssqlOk() {
  return {
    ok: true,
    kind: 'database',
    name: 'HIS数据库(SQL2008)',
    host: '192.168.1.50',
    osLabel: '数据库',
    connectLabel: 'TDS连接',
    db: {
      engine: 'mssql',
      engineLabel: 'SQL Server 2008 (10.0.5500)',
      instance: 'MSSQLSERVER',
      tdsVersion: '7_3_B',
      version: 'Microsoft SQL Server 2008 R2 (SP3) - 10.50.6000.34',
      uptime_sec: 86400 * 45 + 3600 * 7,
      conn_total: 128, conn_active: 23, conn_max: 32767, blocked: 0,
      databases: [
        { name: 'HIS_DB', size_mb: 51200, log_used_pct: 35.2 },
        { name: 'LIS_DB', size_mb: 20480, log_used_pct: 68.4 },
        { name: 'tempdb', size_mb: 1024, log_used_pct: 2.1 }
      ],
      tablespaces: []
    },
    metrics: { hostname: '192.168.1.50', os: 'SQL Server 2008 (10.0.5500)', kernel: '', uptime_sec: 86400 * 45 + 3600 * 7, cores: null, load1: null, load5: null, load15: null, cpu_percent: null, mem_total_mb: null, mem_used_mb: null, mem_percent: null, swap_total_mb: null, swap_used_mb: null, procs: 128, zombies: 0, disks: [] },
    services: [],
    customs: []
  };
}

function demoOracleWarning() {
  return {
    ok: true,
    kind: 'database',
    name: 'PACS数据库(Oracle11g)',
    host: '192.168.1.60',
    osLabel: '数据库',
    connectLabel: 'Oracle连接',
    db: {
      engine: 'oracle',
      engineLabel: 'Oracle 11.2.0.4.0 (OPEN)',
      instance: 'ORCL',
      tdsVersion: null,
      version: 'Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production',
      uptime_sec: 86400 * 120 + 3600 * 5,
      conn_total: 486, conn_active: 52, conn_max: 500, blocked: 2,
      databases: [],
      tablespaces: [
        { name: 'SYSTEM', size_mb: 2048, used_mb: 1024, use_pct: 50.0 },
        { name: 'SYSAUX', size_mb: 4096, used_mb: 2458, use_pct: 60.0 },
        { name: 'PACS_DATA', size_mb: 204800, used_mb: 189440, use_pct: 92.5 },
        { name: 'PACS_IDX', size_mb: 102400, used_mb: 99328, use_pct: 97.0 }
      ]
    },
    metrics: { hostname: '192.168.1.60', os: 'Oracle 11.2.0.4.0 (OPEN)', kernel: '', uptime_sec: 86400 * 120 + 3600 * 5, cores: null, load1: null, load5: null, load15: null, cpu_percent: null, mem_total_mb: null, mem_used_mb: null, mem_percent: null, swap_total_mb: null, swap_used_mb: null, procs: 486, zombies: 2, disks: [] },
    services: [],
    customs: []
  };
}

function demoEsxiOk() {
  return {
    ok: true,
    kind: 'esxi',
    name: 'ESXi宿主机-01',
    host: '192.168.1.200',
    osLabel: 'ESXi',
    connectLabel: 'vSphere API',
    esxi: {
      hostname: 'esxi-host-01',
      product: 'VMware ESXi 8.0.0',
      version: '8.0.0',
      build: '20513097',
      apiVersion: '8.0.0.0',
      vendor: 'Dell Inc.',
      model: 'PowerEdge R740',
      serial: 'ABCD123',
      uuid: '4c4c4544-0042-4310-8044-b7c04f313233',
      cpuModel: 'Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz',
      cpuSockets: 2, cpuCores: 40, cpuThreads: 80, cpuMhz: 2494,
      cpuTotalMhz: 99760, cpuUsedMhz: 12500, cpuPercent: 12.5,
      memTotalMb: 262144, memUsedMb: 98304, memPercent: 37.5,
      uptimeSec: 86400 * 143,
      bootTime: '2026-04-19T08:00:00Z',
      connectionState: 'connected', powerState: 'poweredOn',
      overallStatus: 'green', maintenanceMode: false, rebootRequired: false,
      vmCount: 12, datastoreCount: 3,
      pnics: [
        { device: 'vmnic0', mac: '00:11:22:33:44:55', speed: '10000 Mbps', connected: true },
        { device: 'vmnic1', mac: '00:11:22:33:44:56', speed: '10000 Mbps', connected: true }
      ],
      vms: [
        { name: 'web-server-01', power: 'poweredOn', status: 'green', cpu: 4, memMb: 8192, guestOs: 'Ubuntu Linux (64-bit)', ip: '192.168.1.10' },
        { name: 'db-server-01', power: 'poweredOn', status: 'green', cpu: 8, memMb: 32768, guestOs: 'Windows Server 2019', ip: '192.168.1.20' },
        { name: 'test-vm', power: 'poweredOff', status: 'gray', cpu: 2, memMb: 4096, guestOs: 'CentOS 7', ip: '' }
      ],
      datastores: [
        { name: 'datastore1', type: 'VMFS', capacityMb: 2097152, freeMb: 524288, usedMb: 1572864, usedPercent: 75.0, accessible: true },
        { name: 'NAS-ISO', type: 'NFS', capacityMb: 5242880, freeMb: 4194304, usedMb: 1048576, usedPercent: 20.0, accessible: true }
      ],
      hardwareStatus: null, healthState: null
    },
    metrics: {
      hostname: 'esxi-host-01', os: 'VMware ESXi 8.0.0', kernel: null,
      uptime_sec: 86400 * 143, cores: 40, load1: null, load5: null, load15: null,
      cpu_percent: 12.5, mem_total_mb: 262144, mem_used_mb: 98304, mem_percent: 37.5,
      swap_total_mb: null, swap_used_mb: null, procs: 12, zombies: null, disks: []
    },
    services: [],
    customs: []
  };
}

function buildDemoResults(thresholds) {
  const t = thresholds || {};
  const list = [demoLinuxOk(), demoLinuxWarning(), demoWindowsOk(), demoWindowsCritical(), demoMssqlOk(), demoOracleWarning(), demoEsxiOk(), demoBmcOk(), demoLinuxFail()];
  // 补全 os 字段（大屏按设备类型分组需要）
  const OS_BY_LABEL = { 'Linux': 'linux', 'Windows': 'windows', '管理口': 'bmc', '交换机': 'switch', '数据库': 'database', 'ESXi': 'esxi' };
  return list.map((r) => {
    if (!r.os) r.os = OS_BY_LABEL[r.osLabel] || 'linux';
    return r;
  });
}

module.exports = { buildDemoResults };
