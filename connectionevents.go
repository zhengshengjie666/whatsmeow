// Copyright (c) 2021 Tulir Asokan
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

package whatsmeow

import (
	"sync/atomic"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func (cli *Client) handleStreamError(node *waBinary.Node) {
	atomic.StoreUint32(&cli.isLoggedIn, 0)
	code, _ := node.Attrs["code"].(string)
	conflict, _ := node.GetOptionalChildByTag("conflict")
	conflictType := conflict.AttrGetter().OptionalString("type")
	switch {
	case code == "515":
		cli.Log.Infof("Got 515 code, reconnecting...")
		go func() {
			cli.Disconnect()
			err := cli.Connect()
			if err != nil {
				cli.Log.Errorf("Failed to reconnect after 515 code:", err)
			}
		}()
	case code == "401" && conflictType == "device_removed":
		cli.expectDisconnect()
		cli.Log.Infof("Got device removed stream error, sending LoggedOut event and deleting session")
		go cli.dispatchEvent(&events.LoggedOut{OnConnect: false})
		err := cli.Store.Delete()
		if err != nil {
			cli.Log.Warnf("Failed to delete store after device_removed error: %v", err)
		}
	case conflictType == "replaced":
		cli.expectDisconnect()
		cli.Log.Infof("Got replaced stream error, sending StreamReplaced event")
		go cli.dispatchEvent(&events.StreamReplaced{})
	case code == "503":
		// This seems to happen when the server wants to restart or something.
		// The disconnection will be emitted as an events.Disconnected and then the auto-reconnect will do its thing.
		cli.Log.Warnf("Got 503 stream error, assuming automatic reconnect will handle it")
	default:
		cli.Log.Errorf("Unknown stream error: %s", node.XMLString())
		go cli.dispatchEvent(&events.StreamError{Code: code, Raw: node})
	}
}

func (cli *Client) handleIB(node *waBinary.Node) {
	children := node.GetChildren()
	if len(children) == 1 && children[0].Tag == "downgrade_webclient" {
		go cli.dispatchEvent(&events.QRScannedWithoutMultidevice{})
	}
}

func (cli *Client) handleConnectFailure(node *waBinary.Node) {
	ag := node.AttrGetter()
	reason := ag.String("reason")
	if reason == "401" {
		cli.expectDisconnect()
		cli.Log.Infof("Got 401 connect failure, sending LoggedOut event and deleting session")
		go cli.dispatchEvent(&events.LoggedOut{OnConnect: true})
		err := cli.Store.Delete()
		if err != nil {
			cli.Log.Warnf("Failed to delete store after 401 failure: %v", err)
		}
	} else {
		cli.expectDisconnect()
		cli.Log.Warnf("Unknown connect failure: %s", node.XMLString())
		go cli.dispatchEvent(&events.ConnectFailure{Reason: reason, Raw: node})
	}
}

func (cli *Client) handleConnectSuccess(node *waBinary.Node) {
	cli.Log.Infof("Successfully authenticated")
	cli.LastSuccessfulConnect = time.Now()
	cli.AutoReconnectErrors = 0
	atomic.StoreUint32(&cli.isLoggedIn, 1)
	go func() {
		if dbCount, err := cli.Store.PreKeys.UploadedPreKeyCount(); err != nil {
			cli.Log.Errorf("Failed to get number of prekeys in database: %v", err)
		} else if serverCount, err := cli.getServerPreKeyCount(); err != nil {
			cli.Log.Warnf("Failed to get number of prekeys on server: %v", err)
		} else {
			cli.Log.Debugf("Database has %d prekeys, server says we have %d", dbCount, serverCount)
			if serverCount < MinPreKeyCount || dbCount < MinPreKeyCount {
				cli.uploadPreKeys()
				sc, _ := cli.getServerPreKeyCount()
				cli.Log.Debugf("Prekey count after upload: %d", sc)
			}
		}
		err := cli.SetPassive(false)
		if err != nil {
			cli.Log.Warnf("Failed to send post-connect passive IQ: %v", err)
		}
		cli.dispatchEvent(&events.Connected{})
	}()
}

// SetPassive tells the WhatsApp server whether this device is passive or not.
//
// This seems to mostly affect whether the device receives certain events.
// By default, whatsmeow will automatically do SetPassive(false) after connecting.
func (cli *Client) SetPassive(passive bool) error {
	tag := "active"
	if passive {
		tag = "passive"
	}
	_, err := cli.sendIQ(infoQuery{
		Namespace: "passive",
		Type:      "set",
		To:        types.ServerJID,
		Content:   []waBinary.Node{{Tag: tag}},
	})
	if err != nil {
		return err
	}
	return nil
}
