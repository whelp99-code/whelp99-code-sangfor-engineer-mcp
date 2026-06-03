# HCI Storage Network Guide (6.11)

## Overview

Storage traffic must be isolated from management and VM traffic.

## MTU validation

Before cluster initialization, verify storage VLAN MTU end-to-end. Use MTU 9000 only when switches and NICs support jumbo frames on the full path.

## Bonding

Prefer LACP active-backup or 802.3ad based on switch capability. Document switch port configuration in the change ticket.

## Pre-init checklist

- Management network ping between all nodes
- Storage VLAN tagged on correct interfaces
- DNS and NTP reachable
- License files uploaded
