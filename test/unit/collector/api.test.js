'use strict'

const tap = require('tap')

// TODO: convert to normal tap style.
// Below allows use of mocha DSL with tap runner.
tap.mochaGlobals()

const nock = require('nock')
const chai = require('chai')
const expect = chai.expect
const helper = require('../../lib/agent_helper')
const should = chai.should()
const API = require('../../../lib/collector/api')
const securityPolicies = require('../../lib/fixtures').securityPolicies
const CollectorResponse = require('../../../lib/collector/response')

const HOST = 'collector.newrelic.com'
const PORT = 443
const URL = 'https://' + HOST
const RUN_ID = 1337

const timeout = global.setTimeout
function fast() {
  global.setTimeout = function(cb) {
    return timeout(cb, 0)
  }
}
function slow() { global.setTimeout = timeout }

describe('CollectorAPI', function() {
  var api = null
  var agent = null
  var policies = null

  beforeEach(function() {
    nock.disableNetConnect()
    agent = helper.loadMockedAgent({
      host: HOST,
      port: PORT,
      app_name: ['TEST'],
      ssl: true,
      license_key: 'license key here',
      utilization: {
        detect_aws: false,
        detect_pcf: false,
        detect_azure: false,
        detect_gcp: false,
        detect_docker: false
      },
      browser_monitoring: {},
      transaction_tracer: {}
    })
    agent.reconfigure = function() {}
    agent.setState = function() {}
    api = new API(agent)
    policies = securityPolicies()
  })

  afterEach(function() {
    if (!nock.isDone()) {
      /* eslint-disable no-console */
      console.error('Cleaning pending mocks: %j', nock.pendingMocks())
      /* eslint-enable no-console */
      nock.cleanAll()
    }

    nock.enableNetConnect()
    helper.unloadAgent(agent)
  })

  describe('connect', function() {



    describe('off the happy path', function() {
      var exception = {
        exception: {
          message: 'fake force disconnect',
          error_type: 'NewRelic::Agent::ForceDisconnectException'
        }
      }

      before(function() {
        fast()
      })

      after(function() {
        slow()
      })

      describe('fails after receiving force disconnect', function() {
        var captured = null
        var res = null

        beforeEach(function(done) {
          var redirectURL = helper.generateCollectorPath('preconnect')
          var failure = nock(URL).post(redirectURL).times(1).reply(410, exception)

          api.connect(function test(error, response) {
            captured = error
            res = response

            failure.done()
            done()
          })
        })

        it('should not have gotten an error', function() {
          expect(captured).to.be.null
        })

        it('should not have a response body', function() {
          expect(res.payload).to.not.exist
        })
      })
    })
  })

  describe('reportSettings', function() {
    var bad
    var res
    var payload = {return_value: []}

    before(function(done) {
      api._agent.config.run_id = RUN_ID

      var mock = nock(URL)
        .post(helper.generateCollectorPath('agent_settings', RUN_ID))
        .reply(200, payload)

      api.reportSettings(function test(error, response) {
        bad = error
        res = response
        mock.done()
        done()
      })
    })

    after(function() {
      api._agent.config.run_id = undefined
    })

    it('should not error out', function() {
      should.not.exist(bad)
    })

    it('should return the expected `empty` response', function() {
      expect(res.payload).eql(payload.return_value)
    })
  })

  describe('errorData', function() {
    it('requires errors to send', (done) => {
      api.error_data(null, (err) => {
        expect(err)
          .to.be.an.instanceOf(Error)
          .and.have.property('message', 'must pass errors to send')
        done()
      })
    })

    it('requires a callback', function() {
      expect(function() { api.error_data([], null) })
        .to.throw('callback is required')
    })

    describe('on the happy path', function() {
      let bad = null
      let command = null
      var response = {return_value: []}

      before(function(done) {
        api._agent.config.run_id = RUN_ID
        var shutdown = nock(URL)
          .post(helper.generateCollectorPath('error_data', RUN_ID))
          .reply(200, response)

        var errors = [
          [
            0,                          // timestamp, which is always ignored
            'TestTransaction/Uri/TEST', // transaction name
            'You done screwed up',      // helpful, informative message
            'SampleError',              // Error type (almost always Error in practice)
            {},                         // request parameters
          ]
        ]

        api.error_data(errors, function test(error, res) {
          bad = error
          command = res

          shutdown.done()
          done()
        })
      })

      after(function() {
        api._agent.config.run_id = undefined
      })

      it('should not error out', function() {
        should.not.exist(bad)
      })

      it('should return retain state', function() {
        expect(command).to.have.property('retainData').eql(false)
      })
    })
  })

  describe('sql_trace_data', function() {
    it('requires queries to send', (done) => {
      api.sql_trace_data(null, (err) => {
        expect(err)
          .to.be.an.instanceOf(Error)
          .and.have.property('message', 'must pass queries to send')
        done()
      })
    })

    it('requires a callback', function() {
      expect(function() { api.sql_trace_data([], null) })
        .to.throw('callback is required')
    })

    describe('on the happy path', function() {
      let bad = null

      var response = {return_value: []}

      before(function(done) {
        api._agent.config.run_id = RUN_ID
        var shutdown = nock(URL)
          .post(helper.generateCollectorPath('sql_trace_data', RUN_ID))
          .reply(200, response)

        var queries = [
          [
            'TestTransaction/Uri/TEST',
            '/TEST',
            1234,
            'select * from foo',
            '/Datastore/Mysql/select/foo',
            1,
            700,
            700,
            700,
            'compressed/bas64 params'
          ]
        ]

        api.sql_trace_data(queries, function test(error) {
          bad = error

          shutdown.done()
          done()
        })
      })

      after(function() {
        api._agent.config.run_id = undefined
      })

      it('should not error out', function() {
        should.not.exist(bad)
      })
    })
  })

  describe('analyticsEvents', function() {
    it('requires errors to send', (done) => {
      api.analytic_event_data(null, (err) => {
        expect(err)
          .to.be.an.instanceOf(Error)
          .and.have.property('message', 'must pass events to send')
        done()
      })
    })

    it('requires a callback', function() {
      expect(function() { api.analytic_event_data([], null) })
        .to.throw('callback is required')
    })

    describe('on the happy path', function() {
      let bad = null
      let command = null

      var response = {return_value: []}

      before(function(done) {
        api._agent.config.run_id = RUN_ID
        var endpoint = nock(URL)
          .post(helper.generateCollectorPath('analytic_event_data', RUN_ID))
          .reply(200, response)

        var transactionEvents = [
          RUN_ID,
          [{
            'webDuration': 1.0,
            'timestamp': 1000,
            'name': 'Controller/rails/welcome/index',
            'duration': 1.0,
            'type': 'Transaction'
          },{
            'A': 'a',
            'B': 'b',
          }]
        ]

        api.analytic_event_data(transactionEvents, function test(error, res) {
          bad = error
          command = res

          endpoint.done()
          done()
        })
      })

      after(function() {
        api._agent.config.run_id = undefined
      })

      it('should not error out', function() {
        should.not.exist(bad)
      })

      it('should return retain state', function() {
        expect(command).to.have.property('retainData').eql(false)
      })
    })
  })

  describe('metricData', function() {
    it('requires metrics to send', (done) => {
      api.metric_data(null, (err) => {
        expect(err)
          .to.be.an.instanceOf(Error)
          .and.have.property('message', 'must pass metrics to send')
        done()
      })
    })

    it('requires a callback', function() {
      expect(function() { api.metric_data([], null) })
        .to.throw('callback is required')
    })

    describe('on the happy path', function() {
      let bad = null
      let command = null

      var response = {return_value: []}

      before(function(done) {
        api._agent.config.run_id = RUN_ID
        var shutdown = nock(URL)
          .post(helper.generateCollectorPath('metric_data', RUN_ID))
          .reply(200, response)

        // would like to keep this set of tests relatively self-contained
        var metrics = {
          toJSON: function() {
            return [
              [{name: 'Test/Parent'},  [1,0.026,0.006,0.026,0.026,0.000676]],
              [{name: 'Test/Child/1'}, [1,0.012,0.012,0.012,0.012,0.000144]],
              [{name: 'Test/Child/2'}, [1,0.008,0.008,0.008,0.008,0.000064]]
            ]
          }
        }

        api.metric_data(metrics, function test(error, res) {
          bad = error
          command = res

          shutdown.done()
          done()
        })
      })

      after(function() {
        api._agent.config.run_id = undefined
      })

      it('should not error out', function() {
        should.not.exist(bad)
      })

      it('should return empty data array', function() {
        expect(command).to.have.property('retainData', false)
      })
    })
  })

  describe('transaction_sample_data', function() {
    it('requires slow trace data to send', (done) => {
      api.transaction_sample_data(null, (err) => {
        expect(err)
          .to.be.an.instanceOf(Error)
          .and.have.property('message', 'must pass traces to send')
        done()
      })
    })

    it('requires a callback', function() {
      expect(function() { api.transaction_sample_data([], null) })
        .to.throw('callback is required')
    })

    describe('on the happy path', function() {
      let bad = null

      var response = {return_value: []}

      before(function(done) {
        api._agent.config.run_id = RUN_ID
        var shutdown = nock(URL)
          .post(helper.generateCollectorPath('transaction_sample_data', RUN_ID))
          .reply(200, response)

        // imagine this is a serialized transaction trace
        var trace = []

        api.transaction_sample_data([trace], function test(error) {
          bad = error

          shutdown.done()
          done()
        })
      })

      after(function() {
        api._agent.config.run_id = undefined
      })

      it('should not error out', function() {
        should.not.exist(bad)
      })
    })
  })

  describe('shutdown', function() {
    it('requires a callback', function() {
      expect(function() { api.shutdown(null) }).to.throw('callback is required')
    })

    describe('on the happy path', function() {
      var bad = null
      var command = null

      var response = {return_value: null}

      before(function(done) {
        api._agent.config.run_id = RUN_ID
        var shutdown = nock(URL)
          .post(helper.generateCollectorPath('shutdown', RUN_ID))
          .reply(200, response)

        api.shutdown(function test(error, res) {
          bad = error
          command = res

          shutdown.done()
          done()
        })
      })

      after(function() {
        api._agent.config.run_id = undefined
      })

      it('should not error out', function() {
        should.not.exist(bad)
      })

      it('should return null', function() {
        expect(command).to.exist.and.have.property('payload', null)
      })
    })

    describe('off the happy path', function() {
      describe('fails on a 503 status code', function() {
        var captured = null
        var command = null

        beforeEach(function(done) {
          api._agent.config.run_id = RUN_ID
          var failure = nock(URL)
            .post(helper.generateCollectorPath('shutdown', RUN_ID))
            .reply(503)

          api.shutdown(function test(error, response) {
            captured = error
            command = response

            failure.done()
            done()
          })
        })

        afterEach(function() {
          api._agent.config.run_id = undefined
        })

        it('should have gotten an error', function() {
          expect(captured).to.be.null
        })

        it('should no longer have agent run id', function() {
          expect(api._agent.config.run_id).to.be.undefined
        })

        it('should tell the requester to shut down', () => {
          expect(command.shouldShutdownRun()).to.be.true
        })
      })
    })
  })

  describe('_runLifecycle', function() {
    let method = null

    beforeEach(function() {
      agent.config.run_id = 31337
      delete agent.reconfigure
      agent.stop = function(cb) {
        api.shutdown(cb)
      }

      method = api._methods.metrics
    })

    it('should bail out if disconnected', function(done) {
      api._agent.config.run_id = undefined

      function tested(error) {
        should.exist(error)
        expect(error.message).equals('Not connected to collector.')

        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should discard HTTP 413 errors', function(done) {
      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(413)
      function tested(error) {
        should.not.exist(error)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should discard HTTP 415 errors', function(done) {
      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(415)
      function tested(error) {
        should.not.exist(error)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should discard 413 exceptions', function(done) {
      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(413)
      function tested(error, command) {
        should.not.exist(error)
        expect(command).to.have.property('retainData', false)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should retain after HTTP 500 errors', function(done) {
      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(500)
      function tested(error, command) {
        expect(error).to.not.exist
        expect(command).to.have.property('retainData', true)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should retain after HTTP 503 errors', function(done) {
      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(503)
      function tested(error, command) {
        expect(error).to.not.exist
        expect(command).to.have.property('retainData', true)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should indicate a restart and discard data after 401 errors', (done) => {
      // Call fails.
      const metrics = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(401)

      // Execute!
      api._runLifecycle(method, null, (error, command) => {
        expect(error).to.not.exist

        metrics.done()

        expect(command).to.have.property('retainData', false)
        expect(command.shouldRestartRun()).to.be.true

        done()
      })
    })

    describe('on 409 status', function() {
      it('should indicate reconnect and discard data', function(done) {
        const restart = nock(URL)
          .post(helper.generateCollectorPath('metric_data', 31337))
          .reply(409, {return_value: {}})

        api._runLifecycle(method, null, function(error, command) {
          if (error) {
            console.error(error.stack) // eslint-disable-line no-console
          }
          expect(error).to.not.exist
          expect(command).to.have.property('retainData', false)
          expect(command.shouldRestartRun()).to.be.true

          restart.done()
          done()
        })
      })
    })

    it('should stop the agent on 410 (force disconnect)', function(done) {
      var restart = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(410)
      var shutdown = nock(URL)
        .post(helper.generateCollectorPath('shutdown', 31337))
        .reply(200, {return_value: null})

      function tested(error, command) {
        expect(error).to.not.exist
        expect(command.shouldShutdownRun()).to.be.true

        expect(api._agent.config).property('run_id').to.not.exist

        restart.done()
        shutdown.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should retain data after maintenance notices', function(done) {
      var exception = {
        exception: {
          message: 'Out for a smoke beeearrrbeee',
          error_type: 'NewRelic::Agent::MaintenanceError'
        }
      }

      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(503, exception)
      function tested(error, command) {
        expect(error).to.not.exist
        expect(command).to.have.property('retainData', true)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should retain data after runtime errors', function(done) {
      var exception = {
        exception: {
          message: 'What does this button do?',
          error_type: 'RuntimeError'
        }
      }

      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(500, exception)
      function tested(error, command) {
        expect(error).to.not.exist
        expect(command).to.have.property('retainData', true)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })

    it('should not retain data after unexpected errors', function(done) {
      var failure = nock(URL)
        .post(helper.generateCollectorPath('metric_data', 31337))
        .reply(501)
      function tested(error, command) {
        expect(error).to.not.exist
        expect(command).to.have.property('retainData', false)

        failure.done()
        done()
      }

      api._runLifecycle(method, null, tested)
    })
  })
})

tap.test('succeeds after one 503 on preconnect', (t) => {
  t.autoend()

  let api = null
  let agent = null

  const valid = {
    agent_run_id: RUN_ID
  }

  const response = {return_value: valid}

  let failure = null
  let success = null
  let connection = null

  let bad = null
  let ssc = null

  t.beforeEach((done) => {
    fastSetTimeoutIncrementRef()

    nock.disableNetConnect()

    agent = setupMockedAgent()
    api = new API(agent)

    const redirectURL = helper.generateCollectorPath('preconnect')
    failure = nock(URL).post(redirectURL).reply(503)
    success = nock(URL)
      .post(redirectURL)
      .reply(200, {
        return_value: {redirect_host: HOST, security_policies: {}}
      })
    connection = nock(URL)
      .post(helper.generateCollectorPath('connect'))
      .reply(200, response)

    done()
  })

  t.afterEach((done) => {
    restoreSetTimeout()

    if (!nock.isDone()) {
      /* eslint-disable no-console */
      console.error('Cleaning pending mocks: %j', nock.pendingMocks())
      /* eslint-enable no-console */
      nock.cleanAll()
    }

    nock.enableNetConnect()
    helper.unloadAgent(agent)

    done()
  })

  t.test('should not error out', (t) => {
    testConnect(t, () => {
      t.notOk(bad)
      t.end()
    })
  })

  t.test('should have a run ID', (t) => {
    testConnect(t, () => {
      t.equal(ssc.agent_run_id, RUN_ID)
      t.end()
    })
  })

  t.test('should pass through server-side configuration untouched', (t) => {
    testConnect(t, () => {
      t.deepEqual(ssc, valid)
      t.end()
    })
  })

  function testConnect(t, cb) {
    api.connect((error, res) => {
      bad = error
      ssc = res.payload

      t.ok(failure.isDone())
      t.ok(success.isDone())
      t.ok(connection.isDone())
      cb()
    })
  }
})

// TODO: 503 tests can likely be consolidated into single test func
// passed to t.test() while specifying different # of 503s.
tap.test('succeeds after five 503s on preconnect', (t) => {
  t.autoend()

  let api = null
  let agent = null

  const valid = {
    agent_run_id: RUN_ID
  }

  const response = {return_value: valid}

  let failure = null
  let success = null
  let connection = null

  let bad = null
  let ssc = null

  t.beforeEach((done) => {
    fastSetTimeoutIncrementRef()

    nock.disableNetConnect()

    agent = setupMockedAgent()
    api = new API(agent)

    const redirectURL = helper.generateCollectorPath('preconnect')
    failure = nock(URL).post(redirectURL).times(5).reply(503)
    success = nock(URL)
      .post(redirectURL)
      .reply(200, {
        return_value: {redirect_host: HOST, security_policies: {}}
      })
    connection = nock(URL)
      .post(helper.generateCollectorPath('connect'))
      .reply(200, response)

    done()
  })

  t.afterEach((done) => {
    restoreSetTimeout()

    if (!nock.isDone()) {
      /* eslint-disable no-console */
      console.error('Cleaning pending mocks: %j', nock.pendingMocks())
      /* eslint-enable no-console */
      nock.cleanAll()
    }

    nock.enableNetConnect()
    helper.unloadAgent(agent)

    done()
  })


  t.test('should not error out', (t) => {
    testConnect(t, () => {
      t.notOk(bad)
      t.end()
    })
  })

  t.test('should have a run ID', (t) => {
    testConnect(t, () => {
      t.equal(ssc.agent_run_id, RUN_ID)
      t.end()
    })
  })

  t.test('should pass through server-side configuration untouched', (t) => {
    testConnect(t, () => {
      t.deepEqual(ssc, valid)
      t.end()
    })
  })


  function testConnect(t, cb) {
    api.connect((error, res) => {
      bad = error
      ssc = res.payload

      t.ok(failure.isDone())
      t.ok(success.isDone())
      t.ok(connection.isDone())
      cb()
    })
  }
})

tap.test('retries preconnect until forced to disconnect (410)', (t) => {
  t.autoend()

  let api = null
  let agent = null

  const exception = {
    exception: {
      message: 'fake force disconnect',
      error_type: 'NewRelic::Agent::ForceDisconnectException'
    }
  }

  let failure = null
  let disconnect = null

  let capturedResponse = null

  t.beforeEach((done) => {
    fastSetTimeoutIncrementRef()

    nock.disableNetConnect()

    agent = setupMockedAgent()
    api = new API(agent)

    const redirectURL = helper.generateCollectorPath('preconnect')
    failure = nock(URL).post(redirectURL).times(500).reply(503)
    disconnect = nock(URL).post(redirectURL).times(1).reply(410, exception)

    done()
  })

  t.afterEach((done) => {
    restoreSetTimeout()

    if (!nock.isDone()) {
      /* eslint-disable no-console */
      console.error('Cleaning pending mocks: %j', nock.pendingMocks())
      /* eslint-enable no-console */
      nock.cleanAll()
    }

    nock.enableNetConnect()
    helper.unloadAgent(agent)

    done()
  })

  t.test('should have received shutdown response', (t) => {
    testConnect(t, () => {
      const shutdownCommand = CollectorResponse.AGENT_RUN_BEHAVIOR.SHUTDOWN

      t.ok(capturedResponse)
      t.equal(capturedResponse.agentRun, shutdownCommand)

      t.end()
    })
  })

  function testConnect(t, cb) {
    api.connect((error, response) => {
      capturedResponse = response

      t.ok(failure.isDone())
      t.ok(disconnect.isDone())
      cb()
    })
  }
})


tap.test('retries on receiving invalid license key (401)', (t) => {
  t.autoend()

  let api = null
  let agent = null

  const error = {
    exception: {
      message: 'Invalid license key. Please contact support@newrelic.com.',
      error_type: 'NewRelic::Agent::LicenseException'
    }
  }

  let failure = null
  let success = null
  let connect = null

  t.beforeEach((done) => {
    fastSetTimeoutIncrementRef()

    nock.disableNetConnect()

    agent = setupMockedAgent()
    api = new API(agent)

    const preconnectURL = helper.generateCollectorPath('preconnect')
    failure = nock(URL).post(preconnectURL).times(5).reply(401, error)
    success = nock(URL).post(preconnectURL).reply(200, {return_value: {}})
    connect = nock(URL)
      .post(helper.generateCollectorPath('connect'))
      .reply(200, {return_value: {agent_run_id: 31338}})

    done()
  })

  t.afterEach((done) => {
    restoreSetTimeout()

    if (!nock.isDone()) {
      /* eslint-disable no-console */
      console.error('Cleaning pending mocks: %j', nock.pendingMocks())
      /* eslint-enable no-console */
      nock.cleanAll()
    }

    nock.enableNetConnect()
    helper.unloadAgent(agent)

    done()
  })

  t.test('should call the expected number of times', (t) => {
    testConnect(t, () => {
      t.end()
    })
  })

  function testConnect(t, cb) {
    api.connect(() => {
      t.ok(failure.isDone())
      t.ok(success.isDone())
      t.ok(connect.isDone())

      cb()
    })
  }
})

function fastSetTimeoutIncrementRef() {
  global.setTimeout = function(cb) {
    const nodeTimeout = timeout(cb, 0)

    // This is a hack to keep tap from shutting down test early.
    // Is there a better way to do this?
    setImmediate(() => {
      nodeTimeout.ref()
    })

    return nodeTimeout
  }
}

function restoreSetTimeout() {
  global.setTimeout = timeout
}

function setupMockedAgent() {
  const agent = helper.loadMockedAgent({
    host: HOST,
    port: PORT,
    app_name: ['TEST'],
    ssl: true,
    license_key: 'license key here',
    utilization: {
      detect_aws: false,
      detect_pcf: false,
      detect_azure: false,
      detect_gcp: false,
      detect_docker: false
    },
    browser_monitoring: {},
    transaction_tracer: {}
  })
  agent.reconfigure = function() {}
  agent.setState = function() {}

  return agent
}
