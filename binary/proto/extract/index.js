const request = require("request-promise-native")
const acorn = require("acorn")
const walk = require("acorn-walk")
const fs = require("fs/promises")

const addPrefix = (lines, prefix) => lines.map(line => prefix + line)

async function findAppModules(mods) {
    const ua = {
        headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:95.0) Gecko/20100101 Firefox/95.0",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", /**/
            "Accept-Language": "Accept-Language: en-US,en;q=0.5",
        }
    }
    const baseURL = "https://web.whatsapp.com"
    const index = await request.get(baseURL, ua)
    const bootstrapQRID = index.match(/src="\/bootstrap_qr.([0-9a-z]{10,}).js"/)[1]
    const bootstrapQRURL = baseURL + "/bootstrap_qr." + bootstrapQRID + ".js"
    console.error("Found bootstrap_qr.js URL:", bootstrapQRURL)
    const qrData = await request.get(bootstrapQRURL, ua)
    // This one list of types is so long that it's split into two JavaScript declarations.
    // The module finder below can't handle it, so just patch it manually here.
    const patchedQrData = qrData.replace("ButtonsResponseMessageType=void 0,t.ActionLinkSpec", "ButtonsResponseMessageType=t.ActionLinkSpec")
    const qrModules = acorn.parse(patchedQrData).body[0].expression.arguments[0].elements[1].properties
    return qrModules.filter(m => mods.includes(m.key.value))
}

(async () => {
    // The module IDs that contain protobuf types
    const wantedModules = [
        84593, // AppVersion, UserAgent, WebdPayload ...
        85579, // BizIdentityInfo, BizAccountLinkInfo, ...
        31057, // SyncActionData, StarAction, ...
        97264, // SyncdPatch, SyncdMutation, ...
        17907, // ServerErrorReceipt, MediaRetryNotification, ...
        8506, // MsgOpaqueData, MsgRowOpaqueData
        83723, // GroupParticipant, Pushname, HistorySyncMsg, ...
        43569, // EphemeralSetting
        60934, // CallButton, TemplateButton, ..., ActionLink, ..., QuickReplyButton, URLButton, ...
        77811, // AppVersion, CompanionProps, CompanionPropsPlatform
        9856, // ADVSignedDeviceIdentityHMAC, ADVSignedDeviceIdentity, ...
        75359, // MessageKey
        68719, // Reaction, UserReceipt, PhotoChange, WebMessageInfoStatus, ...
    ]
    // Conflicting specs by module ID and what to rename them to
    const renames = {
        85579: {
            "Details": "VerifiedNameDetails",
        },
        84593: {
            "Details": "NoiseCertificateDetails",
        },
        60934: {
            "MediaData": "PBMediaData",
        }
    }
    const unspecName = name => name.endsWith("Spec") ? name.slice(0, -4) : name
    const makeRenameFunc = modID => name => {
        name = unspecName(name)
        return renames[modID]?.[name] ?? name
    }
    // The constructor ID that's used in all enum types
    const enumConstructorID = 54302

    const unsortedModules = await findAppModules(wantedModules)
    if (unsortedModules.length !== wantedModules.length) {
        console.error("did not find all wanted modules")
        return
    }
    // Sort modules so that whatsapp module id changes don't change the order in the output protobuf schema
    const modules = []
    for (const mod of wantedModules) {
        modules.push(unsortedModules.find(node => node.key.value === mod))
    }

    // find aliases of cross references between the wanted modules
    let modulesInfo = {}
    modules.forEach(({key, value}) => {
        const requiringParam = value.params[2].name
        modulesInfo[key.value] = {crossRefs: []}
        walk.simple(value, {
            VariableDeclarator(node) {
                if (node.init && node.init.type === "CallExpression" && node.init.callee.name === requiringParam && node.init.arguments.length === 1 && wantedModules.indexOf(node.init.arguments[0].value) !== -1) {
                    modulesInfo[key.value].crossRefs.push({alias: node.id.name, module: node.init.arguments[0].value})
                }
            }
        })
    })

    // find all identifiers and, for enums, their array of values
    for (const mod of modules) {
        const modInfo = modulesInfo[mod.key.value]
        const rename = makeRenameFunc(mod.key.value)

        // all identifiers will be initialized to "void 0" (i.e. "undefined") at the start, so capture them here
        walk.ancestor(mod, {
            UnaryExpression(node, anc) {
                if (!modInfo.identifiers && node.operator === "void") {
                    const assignments = []
                    let i = 1
                    anc.reverse()
                    while (anc[i].type === "AssignmentExpression") {
                        assignments.push(anc[i++].left)
                    }
                    const makeBlankIdent = a => {
                        const key = rename(a.property.name)
                        const value = {name: key}
                        if (key !== unspecName(a.property.name)) {
                            value.renamedFrom = unspecName(a.property.name)
                        }
                        return [key, value]
                    }
                    modInfo.identifiers = Object.fromEntries(assignments.map(makeBlankIdent).reverse())
                }
            }
        })
        const enumAliases = {}
        // enums are defined directly, and both enums and messages get a one-letter alias
        walk.simple(mod, {
            AssignmentExpression(node) {
                if (node.left.type === "MemberExpression" && modInfo.identifiers[rename(node.left.property.name)]) {
                    const ident = modInfo.identifiers[rename(node.left.property.name)]
                    ident.alias = node.right.name
                    ident.enumValues = enumAliases[ident.alias]
                }
            },
            VariableDeclarator(node) {
                if (node.init && node.init.type === "CallExpression" && node.init.callee?.arguments?.[0]?.value === enumConstructorID && node.init.arguments.length === 1 && node.init.arguments[0].type === "ObjectExpression") {
                    enumAliases[node.id.name] = node.init.arguments[0].properties.map(p => ({
                        name: p.key.name,
                        id: p.value.value
                    }))
                }
            }
        })
    }

    // find the contents for all protobuf messages
    for (const mod of modules) {
        const modInfo = modulesInfo[mod.key.value]
        const rename = makeRenameFunc(mod.key.value)

        // message specifications are stored in a "internalSpec" attribute of the respective identifier alias
        walk.simple(mod, {
            AssignmentExpression(node) {
                if (node.left.type === "MemberExpression" && node.left.property.name === "internalSpec" && node.right.type === "ObjectExpression") {
                    const targetIdent = Object.values(modInfo.identifiers).find(v => v.alias === node.left.object.name)
                    if (!targetIdent) {
                        console.warn(`found message specification for unknown identifier alias: ${node.left.object.name}`)
                        return
                    }

                    // partition spec properties by normal members and constraints (like "__oneofs__") which will be processed afterwards
                    const constraints = []
                    let members = []
                    for (const p of node.right.properties) {
                        p.key.name = p.key.type === "Identifier" ? p.key.name : p.key.value
                        ;(p.key.name.substr(0, 2) === "__" ? constraints : members).push(p)
                    }

                    members = members.map(({key: {name}, value: {elements}}) => {
                        let type
                        const flags = []
                        const unwrapBinaryOr = n => (n.type === "BinaryExpression" && n.operator === "|") ? [].concat(unwrapBinaryOr(n.left), unwrapBinaryOr(n.right)) : [n]

                        // find type and flags
                        unwrapBinaryOr(elements[1]).forEach(m => {
                            if (m.type === "MemberExpression" && m.object.type === "MemberExpression") {
                                if (m.object.property.name === "TYPES")
                                    type = m.property.name.toLowerCase()
                                else if (m.object.property.name === "FLAGS")
                                    flags.push(m.property.name.toLowerCase())
                            }
                        })

                        // determine cross reference name from alias if this member has type "message" or "enum"
                        if (type === "message" || type === "enum") {
                            const currLoc = ` from member '${name}' of message '${targetIdent.name}'`
                            if (elements[2].type === "Identifier") {
                                type = Object.values(modInfo.identifiers).find(v => v.alias === elements[2].name)?.name
                                if (!type) {
                                    console.warn(`unable to find reference of alias '${elements[2].name}'` + currLoc)
                                }
                            } else if (elements[2].type === "MemberExpression") {
                                const crossRef = modInfo.crossRefs.find(r => r.alias === elements[2].object.name)
                                if (crossRef && modulesInfo[crossRef.module].identifiers[rename(elements[2].property.name)]) {
                                    type = rename(elements[2].property.name)
                                } else {
                                    console.warn(`unable to find reference of alias to other module '${elements[2].object.name}' or to message ${elements[2].property.name} of this module` + currLoc)
                                }
                            }
                        }

                        return {name, id: elements[0].value, type, flags}
                    })

                    // resolve constraints for members
                    constraints.forEach(c => {
                        if (c.key.name === "__oneofs__" && c.value.type === "ObjectExpression") {
                            const newOneOfs = c.value.properties.map(p => ({
                                name: p.key.name,
                                type: "__oneof__",
                                members: p.value.elements.map(e => {
                                    const idx = members.findIndex(m => m.name === e.value)
                                    const member = members[idx]
                                    members.splice(idx, 1)
                                    return member
                                })
                            }))
                            members.push(...newOneOfs)
                        }
                    })

                    targetIdent.members = members
                }
            }
        })
    }

    // make all enums only one message uses be local to that message
    for (const mod of modules) {
        const idents = modulesInfo[mod.key.value].identifiers
        for (const ident of Object.values(idents)) {
            if (!ident.enumValues) {
                continue
            }
            // count number of occurrences of this enumeration and store these identifiers
            const occurrences = Object.values(idents).filter(v => v.members && v.members.find(m => m.type === ident.name))
            // if there's only one occurrence, add the enum to that message. Also remove enums that do not occur anywhere
            if (occurrences.length <= 1) {
                if (occurrences.length === 1) {
                    idents[occurrences[0].name].members.find(m => m.type === ident.name).enumValues = ident.enumValues
                }
                delete idents[ident.name]
            }
        }
    }

    const addedMessages = new Set()
    let decodedProto = [
        'syntax = "proto2";',
        "package proto;",
        ""
    ]
    const spaceIndent = " ".repeat(4)
    for (const mod of modules) {
        const modInfo = modulesInfo[mod.key.value]

        // enum stringifying function
        const stringifyEnum = (ident, overrideName = null) =>
            [].concat(
                [`enum ${overrideName || ident.name} {`],
                addPrefix(ident.enumValues.map(v => `${v.name} = ${v.id};`), spaceIndent),
                ["}"]
            )

        // message specification member stringifying function
        const stringifyMessageSpecMember = (info, completeFlags = true) => {
            if (info.type === "__oneof__") {
                return [].concat(
                    [`oneof ${info.name} {`],
                    addPrefix([].concat(...info.members.map(m => stringifyMessageSpecMember(m, false))), spaceIndent),
                    ["}"]
                )
            } else {
                if (info.flags.includes("packed")) {
                    info.flags.splice(info.flags.indexOf("packed"))
                    info.packed = " [packed=true]"
                }
                if (completeFlags && info.flags.length === 0) {
                    info.flags.push("optional")
                }
                const ret = info.enumValues ? stringifyEnum(info, info.type) : []
                ret.push(`${info.flags.join(" ") + (info.flags.length === 0 ? "" : " ")}${info.type} ${info.name} = ${info.id}${info.packed || ""};`)
                return ret
            }
        }

        // message specification stringifying function
        const stringifyMessageSpec = (ident) => {
            let result = []
            if (ident.renamedFrom) {
                result.push(`// Renamed from ${ident.renamedFrom}`)
            }
            result.push(
                `message ${ident.name} {`,
                ...addPrefix([].concat(...ident.members.map(m => stringifyMessageSpecMember(m))), spaceIndent),
                "}",
            )
            if (addedMessages.has(ident.name)) {
                result = addPrefix(result, "//")
                result.unshift("// Duplicate type omitted")
            } else {
                addedMessages.add(ident.name)
            }
            result.push("")
            return result
        }

        decodedProto = decodedProto.concat(...Object.values(modInfo.identifiers).map(v => v.members ? stringifyMessageSpec(v) : stringifyEnum(v)))
    }
    const decodedProtoStr = decodedProto.join("\n") + "\n"
    await fs.writeFile("../def.proto", decodedProtoStr)
    console.log("Extracted protobuf schema to ../def.proto")
})()
