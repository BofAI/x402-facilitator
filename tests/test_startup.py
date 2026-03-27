import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import pytest


def _patch_lifespan_dependencies(mocker, main_module, networks):
    mocker.patch.object(main_module.config, "load_from_yaml", return_value=None)
    mocker.patch.object(
        main_module.config,
        "inject_agent_wallet_password_env",
        new_callable=AsyncMock,
        return_value=None,
    )
    mocker.patch.object(main_module, "setup_logging", return_value=None)
    mocker.patch("monitoring.start_monitoring_server", return_value=None)
    mocker.patch.object(main_module, "init_database", new_callable=AsyncMock)
    mocker.patch.object(main_module, "dispose_engine", new_callable=AsyncMock)
    mocker.patch.object(main_module.config, "get_database_url", new_callable=AsyncMock, return_value="postgresql+asyncpg://user@localhost/db")
    mocker.patch.object(main_module.config, "get_trongrid_api_key", new_callable=AsyncMock, return_value=None)
    mocker.patch.object(
        main_module.config,
        "get_gasfree_api_credentials",
        new_callable=AsyncMock,
        return_value=(None, None),
    )
    mocker.patch.object(main_module, "api_key_refresher", new_callable=AsyncMock)
    mocker.patch.object(type(main_module.config), "logging_config", new_callable=PropertyMock, return_value={})
    mocker.patch.object(type(main_module.config), "database_max_open_conns", new_callable=PropertyMock, return_value=10)
    mocker.patch.object(type(main_module.config), "database_max_idle_conns", new_callable=PropertyMock, return_value=5)
    mocker.patch.object(type(main_module.config), "database_max_life_time", new_callable=PropertyMock, return_value=600)
    mocker.patch.object(type(main_module.config), "database_ssl_mode", new_callable=PropertyMock, return_value="disable")
    mocker.patch.object(type(main_module.config), "networks", new_callable=PropertyMock, return_value=networks)
    mocker.patch.object(main_module.config, "get_base_fee", return_value={"USDT": 100})


def test_main_injects_agent_wallet_password_before_uvicorn_run(mocker, monkeypatch):
    import main

    monkeypatch.delenv("AGENT_WALLET_PASSWORD", raising=False)
    mocker.patch.object(main.config, "load_from_yaml", return_value=None)

    async def inject_password():
        os.environ["AGENT_WALLET_PASSWORD"] = "wallet-pass"

    mocker.patch.object(
        main.config,
        "inject_agent_wallet_password_env",
        new_callable=AsyncMock,
        side_effect=inject_password,
    )

    def run_coroutine(coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    mocker.patch.object(main.asyncio, "run", side_effect=run_coroutine)

    def run_uvicorn(*args, **kwargs):
        assert os.getenv("AGENT_WALLET_PASSWORD") == "wallet-pass"

    uvicorn_run = mocker.patch.object(main.uvicorn, "run", side_effect=run_uvicorn)

    main.main()

    uvicorn_run.assert_called_once()
    main.config.inject_agent_wallet_password_env.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_lifespan_uses_tron_wallet_provider(mocker):
    import main

    _patch_lifespan_dependencies(mocker, main, ["tron:nile"])
    injected_password = "wallet-pass"
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.delenv("AGENT_WALLET_PASSWORD", raising=False)
    tron_signer = MagicMock()
    permit_mechanism = MagicMock()
    permit_mechanism.scheme.return_value = "exact_permit"
    exact_mechanism = MagicMock()
    exact_mechanism.scheme.return_value = "exact"
    gasfree_client_cls = mocker.patch.object(main, "GasFreeAPIClient")

    async def inject_password():
        import os
        os.environ["AGENT_WALLET_PASSWORD"] = injected_password

    mocker.patch.object(
        main.config,
        "inject_agent_wallet_password_env",
        new_callable=AsyncMock,
        side_effect=inject_password,
    )

    async def create_tron_signer():
        import os
        assert os.getenv("AGENT_WALLET_PASSWORD") == injected_password
        return tron_signer

    create_mock = mocker.patch.object(
        main.TronFacilitatorSigner,
        "create",
        new_callable=AsyncMock,
        side_effect=create_tron_signer,
    )
    mocker.patch.object(main, "ExactPermitTronFacilitatorMechanism", return_value=permit_mechanism)
    mocker.patch.object(main, "ExactTronFacilitatorMechanism", return_value=exact_mechanism)
    register_mock = mocker.patch.object(main.x402_facilitator, "register", return_value=main.x402_facilitator)

    async with main.lifespan(main.app):
        pass

    monkeypatch.undo()
    main.config.inject_agent_wallet_password_env.assert_awaited_once_with()
    create_mock.assert_awaited_once_with()
    main.config.get_gasfree_api_credentials.assert_awaited_once_with("tron:nile")
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], exact_mechanism)
    gasfree_client_cls.assert_not_called()


@pytest.mark.asyncio
async def test_lifespan_registers_gasfree_when_credentials_present(mocker):
    import main

    _patch_lifespan_dependencies(mocker, main, ["tron:nile"])
    mocker.patch.object(
        main.config,
        "get_gasfree_api_credentials",
        new_callable=AsyncMock,
        return_value=("gf-key", "gf-secret"),
    )
    tron_signer = MagicMock()
    permit_mechanism = MagicMock()
    permit_mechanism.scheme.return_value = "exact_permit"
    exact_mechanism = MagicMock()
    exact_mechanism.scheme.return_value = "exact"
    gasfree_mechanism = MagicMock()
    gasfree_mechanism.scheme.return_value = "exact_gasfree"

    create_mock = mocker.patch.object(
        main.TronFacilitatorSigner,
        "create",
        new_callable=AsyncMock,
        return_value=tron_signer,
    )
    mocker.patch.object(main, "ExactPermitTronFacilitatorMechanism", return_value=permit_mechanism)
    mocker.patch.object(main, "ExactTronFacilitatorMechanism", return_value=exact_mechanism)
    mocker.patch.object(main, "ExactGasFreeFacilitatorMechanism", return_value=gasfree_mechanism)
    gasfree_client_cls = mocker.patch.object(main, "GasFreeAPIClient", return_value=MagicMock())
    register_mock = mocker.patch.object(main.x402_facilitator, "register", return_value=main.x402_facilitator)

    async with main.lifespan(main.app):
        pass

    create_mock.assert_awaited_once_with()
    main.config.get_gasfree_api_credentials.assert_awaited_once_with("tron:nile")
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], exact_mechanism)
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], gasfree_mechanism)
    gasfree_client_cls.assert_called_once()


@pytest.mark.asyncio
async def test_lifespan_uses_evm_wallet_provider(mocker):
    import main

    _patch_lifespan_dependencies(mocker, main, ["bsc:testnet"])
    evm_signer = MagicMock()
    permit_mechanism = MagicMock()
    permit_mechanism.scheme.return_value = "exact_permit"
    exact_mechanism = MagicMock()
    exact_mechanism.scheme.return_value = "exact"

    create_mock = mocker.patch.object(
        main.EvmFacilitatorSigner,
        "create",
        new_callable=AsyncMock,
        return_value=evm_signer,
    )
    mocker.patch.object(main, "ExactPermitEvmFacilitatorMechanism", return_value=permit_mechanism)
    mocker.patch.object(main, "ExactEvmFacilitatorMechanism", return_value=exact_mechanism)
    register_mock = mocker.patch.object(main.x402_facilitator, "register", return_value=main.x402_facilitator)

    async with main.lifespan(main.app):
        pass

    create_mock.assert_awaited_once_with()
    register_mock.assert_any_call([main.to_internal_network["bsc:testnet"]], permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["bsc:testnet"]], exact_mechanism)


@pytest.mark.asyncio
async def test_lifespan_reports_wallet_provider_error(mocker):
    import main

    _patch_lifespan_dependencies(mocker, main, ["tron:nile"])
    mocker.patch.object(
        main.TronFacilitatorSigner,
        "create",
        new_callable=AsyncMock,
        side_effect=RuntimeError("no active wallet"),
    )

    with pytest.raises(
        RuntimeError,
        match="Failed to initialize facilitator signer for tron:nile",
    ):
        async with main.lifespan(main.app):
            pass


@pytest.mark.asyncio
async def test_lifespan_reuses_signers_across_same_chain_type(mocker):
    import main

    _patch_lifespan_dependencies(
        mocker,
        main,
        ["tron:nile", "tron:mainnet", "bsc:testnet", "bsc:mainnet"],
    )

    tron_signer = MagicMock()
    evm_signer = MagicMock()
    tron_permit_mechanism = MagicMock()
    tron_permit_mechanism.scheme.return_value = "exact_permit"
    tron_exact_mechanism = MagicMock()
    tron_exact_mechanism.scheme.return_value = "exact"
    evm_permit_mechanism = MagicMock()
    evm_permit_mechanism.scheme.return_value = "exact_permit"
    evm_exact_mechanism = MagicMock()
    evm_exact_mechanism.scheme.return_value = "exact"

    tron_create_mock = mocker.patch.object(
        main.TronFacilitatorSigner,
        "create",
        new_callable=AsyncMock,
        return_value=tron_signer,
    )
    evm_create_mock = mocker.patch.object(
        main.EvmFacilitatorSigner,
        "create",
        new_callable=AsyncMock,
        return_value=evm_signer,
    )
    mocker.patch.object(main, "ExactPermitTronFacilitatorMechanism", return_value=tron_permit_mechanism)
    mocker.patch.object(main, "ExactTronFacilitatorMechanism", return_value=tron_exact_mechanism)
    mocker.patch.object(main, "ExactPermitEvmFacilitatorMechanism", return_value=evm_permit_mechanism)
    mocker.patch.object(main, "ExactEvmFacilitatorMechanism", return_value=evm_exact_mechanism)
    register_mock = mocker.patch.object(main.x402_facilitator, "register", return_value=main.x402_facilitator)

    async with main.lifespan(main.app):
        pass

    tron_create_mock.assert_awaited_once_with()
    evm_create_mock.assert_awaited_once_with()
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], tron_permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["tron:nile"]], tron_exact_mechanism)
    register_mock.assert_any_call([main.to_internal_network["tron:mainnet"]], tron_permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["tron:mainnet"]], tron_exact_mechanism)
    register_mock.assert_any_call([main.to_internal_network["bsc:testnet"]], evm_permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["bsc:testnet"]], evm_exact_mechanism)
    register_mock.assert_any_call([main.to_internal_network["bsc:mainnet"]], evm_permit_mechanism)
    register_mock.assert_any_call([main.to_internal_network["bsc:mainnet"]], evm_exact_mechanism)
