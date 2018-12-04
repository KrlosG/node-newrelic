'use strict'

var sinon = require('sinon')
var chai = require('chai')
var should = chai.should()
var expect = chai.expect
var nock = require('nock')
var helper = require('../../lib/agent_helper')
var sampler = require('../../../lib/sampler')
var semver = require('semver')
var configurator = require('../../../lib/config')
var Agent = require('../../../lib/agent')
var Transaction = require('../../../lib/transaction')
var clearAWSCache = require('../../../lib/utilization/aws-info').clearCache


/*
 *
 * CONSTANTS
 *
 */
var RUN_ID = 1337
var URL = 'https://collector.newrelic.com'

// TODO: do we need to mock AWS (and other vendors) in these tests?
// Why not just disable?
var awsHost = 'http://169.254.169.254'

var awsResponses = {
  'dynamic/instance-identity/document': {
    'instanceType': 'test.type',
    'instanceId': 'test.id',
    'availabilityZone': 'us-west-2b'
  }
}

var awsRedirect

function refreshAWSEndpoints() {
  clearAWSCache()
  awsRedirect = nock(awsHost)
  for (var awsPath in awsResponses) { // eslint-disable-line guard-for-in
    var redirect = awsRedirect.get('/2016-09-02/' + awsPath)
    redirect.reply(200, awsResponses[awsPath])
  }
}


describe('the New Relic agent', function() {
  before(function() {
    nock.disableNetConnect()
    refreshAWSEndpoints()
  })

  after(function() {
    nock.enableNetConnect()
  })

  it('requires the configuration be passed to the constructor', function() {
    expect(function() { new Agent() }).to.throw() // eslint-disable-line no-new
  })

  it('does not throw when passed a valid configuration', function() {
    var config = configurator.initialize({agent_enabled: false})
    var agent = new Agent(config)

    expect(agent.config.agent_enabled).equal(false)
  })

  describe('when in serverless_mode', () => {
    let agent = null

    before(() => {
      agent = helper.loadMockedAgent(null, {
        serverless_mode: {
          enabled: true
        },
        feature_flag: {
          serverless_mode: true
        }
      })
    })

    after(() => {
      helper.unloadAgent(agent)
    })

    it('should set all sampling limits to Infinity', () => {
      expect(agent.events.limit).to.equal(Infinity)
      expect(agent.customEvents.limit).to.equal(Infinity)
      expect(agent.spans.limit).to.equal(Infinity)
      expect(agent.errors.limit).to.equal(Infinity)
    })
  })

  describe('when configured', function() {
    var agent

    beforeEach(function() {
      agent = helper.loadMockedAgent()
    })

    afterEach(function() {
      helper.unloadAgent(agent)
    })

    it('bootstraps its configuration', function() {
      should.exist(agent.config)
    })

    it('has an error tracer', function() {
      should.exist(agent.errors)
    })

    it('has query tracer', function() {
      should.exist(agent.queries)
    })

    it('uses an aggregator to apply top N slow trace logic', function() {
      should.exist(agent.traces)
    })

    it('has a URL normalizer', function() {
      should.exist(agent.urlNormalizer)
    })

    it('has a metric name normalizer', function() {
      should.exist(agent.metricNameNormalizer)
    })

    it('has a transaction name normalizer', function() {
      should.exist(agent.transactionNameNormalizer)
    })

    it('has a consolidated metrics collection that transactions feed into', function() {
      should.exist(agent.metrics)
    })

    it('has a function to look up the active transaction', function() {
      expect(function() { agent.getTransaction() }).not.throws()
    })

    it('requires new configuration to reconfigure the agent', function() {
      expect(function() { agent.reconfigure() }).throws()
    })

    it('defaults to a state of `stopped`', function() {
      expect(agent._state).equal('stopped')
    })

    it('requires a valid value when changing state', function() {
      expect(function() { agent.setState('bogus') }).throws('Invalid state bogus')
    })

    it('has some debugging configuration by default', function() {
      should.exist(agent.config.debug)
    })

    describe('with naming rules configured', function() {
      var configured
      beforeEach(function() {
        var config = configurator.initialize({
          rules: {name: [
            {pattern: '^/t',  name: 'u'},
            {pattern: /^\/u/, name: 't'}
          ]}
        })
        configured = new Agent(config)
      })

      it('loads the rules', function() {
        var rules = configured.userNormalizer.rules
        expect(rules.length).equal(2 + 1) // +1 default ignore rule

        // Rules are reversed by default
        expect(rules[2].pattern.source).equal('^\\/u')

        if (semver.satisfies(process.versions.node, '>=1.0.0')) {
          expect(rules[1].pattern.source).equal('^\\/t')
        } else {
          expect(rules[1].pattern.source).equal('^/t')
        }
      })
    })

    describe('with ignoring rules configured', function() {
      var configured

      beforeEach(function() {
        var config = configurator.initialize({
          rules: {ignore: [
            /^\/ham_snadwich\/ignore/
          ]}
        })
        configured = new Agent(config)
      })

      it('loads the rules', function() {
        var rules = configured.userNormalizer.rules
        expect(rules.length).equal(1)
        expect(rules[0].pattern.source).equal('^\\/ham_snadwich\\/ignore')
        expect(rules[0].ignore).equal(true)
      })
    })

    describe('when forcing transaction ignore status', function() {
      var agent

      beforeEach(function() {
        var config = configurator.initialize({
          rules: {ignore: [
            /^\/ham_snadwich\/ignore/
          ]}
        })
        agent = new Agent(config)
      })

      it('should not error when forcing an ignore', function() {
        var transaction = new Transaction(agent)
        transaction.forceIgnore = true
        transaction.finalizeNameFromUri('/ham_snadwich/attend', 200)
        expect(transaction.ignore).equal(true)

        expect(function() { transaction.end() }).not.throws()
      })

      it('should not error when forcing a non-ignore', function() {
        var transaction = new Transaction(agent)
        transaction.forceIgnore = false
        transaction.finalizeNameFromUri('/ham_snadwich/ignore', 200)
        expect(transaction.ignore).equal(false)

        expect(function() { transaction.end() }).not.throws()
      })

      it('should ignore when finalizeNameFromUri is not called', function() {
        var transaction = new Transaction(agent)
        transaction.forceIgnore = true
        agent._transactionFinished(transaction)
        expect(transaction.ignore).equal(true)
      })
    })

    describe('when starting', function() {
      it('should require a callback', function() {
        expect(function() { agent.start() }).throws('callback required!')
      })

      it('should change state to `starting`', function(done) {
        agent.collector.connect = function() { done() }
        agent.start(function cb_start() {})
        expect(agent._state).equal('starting')
      })

      it('should not error when disabled via configuration', function(done) {
        agent.config.agent_enabled = false
        agent.collector.connect = function() {
          done(new Error('should not be called'))
        }
        agent.start(done)
      })

      it('should emit `stopped` when disabled via configuration', function(done) {
        agent.config.agent_enabled = false
        agent.collector.connect = function() {
          done(new Error('should not be called'))
        }
        agent.start(function cb_start() {
          expect(agent._state).equal('stopped')
          done()
        })
      })

      it('should error when no license key is included', function(done) {
        agent.config.license_key = undefined
        agent.collector.connect = function() {
          done(new Error('should not be called'))
        }
        agent.start(function cb_start(error) {
          should.exist(error)

          done()
        })
      })

      it('should say why startup failed without license key', function(done) {
        agent.config.license_key = undefined
        agent.collector.connect = function() {
          done(new Error('should not be called'))
        }
        agent.start(function cb_start(error) {
          expect(error.message).equal('Not starting without license key!')

          done()
        })
      })

      it('should call connect when using proxy', function(done) {
        agent.config.proxy = 'fake://url'

        agent.collector.connect = function(callback) {
          should.exist(callback)
          callback()
        }

        agent.start(done)
      })

      it('should call connect when config is correct', function(done) {
        agent.collector.connect = function(callback) {
          should.exist(callback)
          callback()
        }

        agent.start(done)
      })

      it('should error when connection fails', function(done) {
        var passed = new Error('passin on through')

        agent.collector.connect = function(callback) {
          callback(passed)
        }

        agent.start(function cb_start(error) {
          expect(error).equal(passed)

          done()
        })
      })

      it('should harvest at connect when metrics are already there', function(done) {
        var metrics = nock(URL)
          .post(helper.generateCollectorPath('metric_data', RUN_ID))
          .reply(200, {return_value: []})

        agent.collector.connect = function(callback) {
          callback(null, {agent_run_id: RUN_ID})
        }

        agent.config.run_id = RUN_ID

        agent.metrics.measureMilliseconds('Test/Bogus', null, 1)

        agent.start(function cb_start(error) {
          should.not.exist(error)

          metrics.done()
          done()
        })
      })

      it('should not blow up when harvest cycle runs', function(done) {
        var origInterval = global.setInterval
        global.setInterval = function(callback) {
          return Object.assign({unref: function() {}}, setImmediate(callback))
        }

        // manually harvesting
        agent.config.no_immediate_harvest = true

        var redirect = nock(URL)
          .post(helper.generateCollectorPath('preconnect'))
          .reply(200, {
            return_value: {
              redirect_host: 'collector.newrelic.com',
              security_policies: {}
            }
          })
        var connect = nock(URL)
          .post(helper.generateCollectorPath('connect'))
          .reply(200, {return_value: {agent_run_id: RUN_ID}})
        var settings = nock(URL)
          .post(helper.generateCollectorPath('agent_settings', RUN_ID))
          .reply(200, {return_value: []})

        agent.start(function cb_start() {
          setTimeout(function() {
            global.setInterval = origInterval

            redirect.done()
            awsRedirect.done()
            connect.done()
            settings.done()
            done()
          }, 15)
        })
      })

      it('should not blow up when harvest cycle errors', function(done) {
        var origInterval = global.setInterval
        global.setInterval = function(callback) {
          return Object.assign({unref: function() {}}, setImmediate(callback))
        }

        var redirect = nock(URL)
          .post(helper.generateCollectorPath('preconnect'))
          .reply(200, {
            return_value: {
              redirect_host: 'collector.newrelic.com',
              security_policies: {}
            }
          })
        var connect = nock(URL)
          .post(helper.generateCollectorPath('connect'))
          .reply(200, {return_value: {agent_run_id: RUN_ID}})
        var settings = nock(URL)
          .post(helper.generateCollectorPath('agent_settings', RUN_ID))
          .reply(200, {return_value: []})
        var metrics = nock(URL)
          .post(helper.generateCollectorPath('metric_data', RUN_ID))
          .reply(503)

        agent.start(function cb_start() {
          setTimeout(function() {
            global.setInterval = origInterval

            redirect.done()
            connect.done()
            awsRedirect.done()
            settings.done()
            metrics.done()
            done()
          }, 15)
        })
      })
    })

    describe('when stopping', function() {
      function nop() {}

      it('should require a callback', function() {
        expect(function() { agent.stop() }).throws('callback required!')
      })

      it('should not error if no harvester handle is set', function() {
        agent.harvesterHandle = undefined
        agent.collector.shutdown = nop

        expect(function() { agent.stop(nop) }).not.throws()
      })

      it('should not error if a harvester handle is set', function() {
        agent.harvesterHandle = setInterval(function() { throw new Error('nope') }, 5)
        agent.collector.shutdown = nop

        expect(function() { agent.stop(nop) }).not.throws()
      })

      it('should clear harvester handle is set', function() {
        agent.harvesterHandle = setInterval(function() { throw new Error('nope') }, 5)
        agent.collector.shutdown = nop

        agent.stop(nop)
        should.not.exist(agent.harvesterHandle)
      })

      it('should stop sampler', function() {
        sampler.start(agent)
        agent.collector.shutdown = nop
        agent.stop(nop)

        expect(sampler.state).equal('stopped')
      })

      it('should change state to `stopping`', function() {
        sampler.start(agent)
        agent.collector.shutdown = nop
        agent.stop(nop)

        expect(agent._state).equal('stopping')
      })


      it('should not shut down connection if not connected', function(done) {
        agent.stop(function cb_stop(error) {
          should.not.exist(error)
          done()
        })
      })

      describe('if connected', function() {
        it('should call shutdown', function(done) {
          agent.config.run_id = RUN_ID
          var shutdown = nock(URL)
            .post(helper.generateCollectorPath('shutdown', RUN_ID))
            .reply(200, {return_value: null})

          agent.stop(function cb_stop(error) {
            should.not.exist(error)

            shutdown.done()
            done()
          })
        })

        it('should pass through error if shutdown fails', (done) => {
          agent.config.run_id = RUN_ID
          var shutdown = nock(URL)
            .post(helper.generateCollectorPath('shutdown', RUN_ID))
            .replyWithError('whoops!')

          agent.stop((error) => {
            expect(error).to.exist.and.have.property('message', 'whoops!')

            shutdown.done()
            done()
          })
        })
      })
    })

    describe('when calling out to the collector', function() {
      it('should update the metric apdexT value when config changes', (done) => {
        expect(agent.metrics.apdexT).equal(0.1)
        process.nextTick(function cb_nextTick() {
          should.exist(agent.metrics.apdexT)
          expect(agent.metrics.apdexT).equal(0.666)

          done()
        })

        agent.config.emit('apdex_t', 0.666)
      })

      it('should reset the config and metrics normalizer on connection', (done) => {
        var config = {
          agent_run_id: 404,
          apdex_t: 0.742,
          data_report_period: 69,
          url_rules: []
        }

        var redirect = nock(URL)
          .post(helper.generateCollectorPath('preconnect'))
          .reply(200, {
            return_value: {
              redirect_host: 'collector.newrelic.com',
              security_policies: {}
            }
          })
        var handshake = nock(URL)
          .post(helper.generateCollectorPath('connect'))
          .reply(200, {return_value: config})
        var settings = nock(URL)
          .post(helper.generateCollectorPath('agent_settings', 404))
          .reply(200, {return_value: config})
        var metrics = nock(URL)
          .post(helper.generateCollectorPath('metric_data', 404))
          .reply(200, {return_value: []})
        var shutdown = nock(URL)
          .post(helper.generateCollectorPath('shutdown', 404))
          .reply(200, {return_value: null})

        agent.start(function cb_start(error) {
          should.not.exist(error)
          redirect.done()
          handshake.done()

          expect(agent._state).equal('started')
          expect(agent.config.run_id).equal(404)
          expect(agent.config.data_report_period).equal(69)
          expect(agent.metrics.apdexT).equal(0.742)
          expect(agent.urlNormalizer.rules).deep.equal([])

          agent.stop(function cb_stop() {
            settings.done()
            metrics.done()
            awsRedirect.done()
            shutdown.done()
            done()
          })
        })
      })

      it('should capture the trace off a finished transaction', function(done) {
        var trans = new Transaction(agent)
        // need to initialize the trace
        trans.trace.setDurationInMillis(2100)

        agent.once('transactionFinished', function() {
          var trace = agent.traces.trace
          should.exist(trace)
          expect(trace.getDurationInMillis(), 'same trace just passed in').equal(2100)

          return done()
        })

        trans.end()
      })

      it('should capture the synthetic trace off a finished transaction', function(done) {
        var trans = new Transaction(agent)
        // need to initialize the trace
        trans.trace.setDurationInMillis(2100)
        trans.syntheticsData = {
          version: 1,
          accountId: 357,
          resourceId: 'resId',
          jobId: 'jobId',
          monitorId: 'monId'
        }

        agent.once('transactionFinished', function() {
          expect(agent.traces.trace).not.exist
          expect(agent.traces.syntheticsTraces).length(1)
          var trace = agent.traces.syntheticsTraces[0]
          expect(trace.getDurationInMillis(), 'same trace just passed in').equal(2100)

          return done()
        })

        trans.end()
      })
    })

    describe('when apdex_t changes', function() {
      var APDEX_T = 0.9876

      it('should update the current metrics collection\'s apdexT', function() {
        expect(agent.metrics.apdexT).not.equal(APDEX_T)

        agent._apdexTChange(APDEX_T)

        expect(agent.metrics.apdexT).equal(APDEX_T)
      })
    })

    describe('when handling finished transactions', function() {
      var transaction

      beforeEach(function() {
        transaction = new Transaction(agent)
        transaction.ignore = true
      })

      it('should not merge metrics when transaction is ignored', function() {
        /* Top-level method is bound into EE, so mock the metrics collection
         * instead.
         */
        var mock = sinon.mock(agent.metrics)
        mock.expects('merge').never()

        transaction.end()
      })

      it('should not merge errors when transaction is ignored', function() {
        /* Top-level method is bound into EE, so mock the error tracer instead.
         */
        var mock = sinon.mock(agent.errors)
        mock.expects('onTransactionFinished').never()

        transaction.end()
      })

      it('should not aggregate trace when transaction is ignored', function() {
        /* Top-level *and* second-level methods are bound into EEs, so mock the
         * transaction trace record method instead.
         */
        var mock = sinon.mock(transaction)
        mock.expects('record').never()

        transaction.end()
      })
    })

    describe('when tweaking the harvest cycle', function() {
      afterEach(function() {
        agent._stopHarvester()
      })

      it('should begin with no harvester active', function() {
        expect(agent.harvesterHandle).to.not.exist
      })

      it('should start a harvester without throwing', function() {
        expect(function() { agent._scheduleHarvester(10) }).not.throws()
        expect(agent.harvesterHandle).to.exist
      })

      it('should stop an unstarted harvester without throwing', function() {
        expect(function() { agent._scheduleHarvester(10) }).not.throws()
      })

      it('should stop a started harvester', function() {
        agent._scheduleHarvester(10)
        agent._stopHarvester()
        expect(agent.harvesterHandle).to.not.exist
      })

      it('should restart an unstarted harvester without throwing', function() {
        expect(function() { agent._restartHarvester(10) }).not.throws()
        expect(agent.harvesterHandle).to.exist
      })

      it('should restart a started harvester', function() {
        agent._scheduleHarvester(10)
        var before = agent.harvesterHandle
        expect(before).to.exist
        agent._restartHarvester(10)
        expect(agent.harvesterHandle).not.equal(before)
      })

      it('should not alter interval when harvester\'s not running', function(done) {
        expect(agent.harvesterHandle).to.not.exist
        agent._harvesterIntervalChange(13, function() {
          expect(agent.harvesterHandle).to.not.exist

          done()
        })
      })

      it('should not crash when no callback is passed on interval change', function() {
        agent.harvesterHandle = setInterval(function() {}, 2 << 40)
        expect(function() { agent._harvesterIntervalChange(69) }).not.throws()
      })

      it('should alter interval when harvester\'s not running', function(done) {
        agent._scheduleHarvester(10)
        var before = agent.harvesterHandle
        expect(before).to.exist

        agent._harvesterIntervalChange(13, function(error) {
          expect(error.message).equal('Not connected to New Relic!')
          expect(agent.harvesterHandle).not.equal(before)

          done()
        })
      })
    })

    describe('when sampling_target changes', function() {
      it('should adjust the current sampling target', () => {
        expect(agent.transactionSampler.samplingTarget).to.not.equal(5)
        agent.config.onConnect({sampling_target: 5})
        expect(agent.transactionSampler.samplingTarget).to.equal(5)
      })

      it('should adjust the sampling period', () => {
        expect(agent.transactionSampler.samplingPeriod).to.not.equal(100)
        agent.config.onConnect({sampling_target_period_in_seconds: 0.1})
        expect(agent.transactionSampler.samplingPeriod).to.equal(100)
      })
    })
  })
})
